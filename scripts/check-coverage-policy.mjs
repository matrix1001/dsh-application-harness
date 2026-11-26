#!/usr/bin/env node
/**
 * The coverage policy: one place that decides what "enough" means.
 *
 * Vitest's own thresholds cannot express this repo's tiers (per-file 100% for
 * the application contracts, an aggregate floor everywhere else), so vitest
 * reports coverage and this gate judges it:
 *
 * - **T0 contracts** — `packages/application/**​/src/**`: per-file 100% on
 *   lines, statements, functions and branches. These files carry the protocol,
 *   permissions, storage and the call bridge; an uncovered branch there is an
 *   untested failure path, not a cosmetic gap.
 * - **T1 floor** — every measured file together: lines ≥97, statements ≥97,
 *   functions ≥95, branches ≥92. Keeps the rest of the tree from rotting
 *   without demanding 100% on a view component.
 * - **Exemptions** — an explicit list below. Each entry needs a reason; the
 *   gate prints them so a quarterly review can see what is being excused.
 *
 * The intended first question for an uncovered line is "should this code
 * exist?" — dead code is deleted, not tested.
 *
 * Usage: node scripts/check-coverage-policy.mjs [coverageDir]
 * @module scripts/check-coverage-policy
 */

import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The contract packages that must stay at per-file 100%. */
export const CORE_SCOPE = /^packages\/application\/[^/]+\/src\//u

/**
 * The aggregate floor for every measured file. Ratchet: raise every metric by
 * one point each month (next: 99/99/97/95) until a metric stops being reachable
 * without lowering a tier — the last point is not worth a cosmetic test.
 */
export const FLOOR = { lines: 98, statements: 98, functions: 96, branches: 94 }

/**
 * The same floor for files OUTSIDE the T0 contracts. T0's per-file 100% must
 * not subsidise the rest of the tree: this is the non-core line that must hold
 * on its own (ratchet target after the audit: 97/97/95/92).
 */
export const REST_FLOOR = { lines: 97, statements: 97, functions: 95, branches: 92 }

/**
 * Files the policy deliberately excuses. Add an entry only with a reason and
 * an owner; an empty list is the normal state.
 * @type {{ scope: RegExp, reason: string }[]}
 */
export const EXEMPT = []

/**
 * The metric totals of one istanbul file entry.
 * @param {object} entry - the istanbul coverage entry.
 * @returns {{ lines: {covered: number, total: number}, statements: {covered: number, total: number}, functions: {covered: number, total: number}, branches: {covered: number, total: number} }} the totals.
 */
export function totalsOf(entry) {
  const statementLines = new Map()
  for (const [id, loc] of Object.entries(entry.statementMap ?? {})) {
    const line = loc.start?.line
    if (!Number.isFinite(line)) continue
    const hit = (entry.s?.[id] ?? 0) > 0
    statementLines.set(line, (statementLines.get(line) ?? true) && hit)
  }
  let lineCovered = 0
  for (const hit of statementLines.values()) if (hit) lineCovered += 1
  const count = (map) => {
    const values = Object.values(map ?? {})
    const covered = values.filter(value => (Array.isArray(value) ? value : [value]).every(item => item > 0)).length
    return { covered, total: values.length }
  }
  const statements = count(entry.s)
  const functions = count(entry.f)
  const branchTotal = Object.values(entry.b ?? {}).reduce((sum, item) => sum + item.length, 0)
  const branchCovered = Object.values(entry.b ?? {}).reduce((sum, item) => sum + item.filter(value => value > 0).length, 0)
  return {
    lines: { covered: lineCovered, total: statementLines.size },
    statements,
    functions,
    branches: { covered: branchCovered, total: branchTotal },
  }
}

/** Whether a metric total satisfies a percentage requirement. */
export function meets(metric, required) {
  return metric.total === 0 || (metric.covered / metric.total) * 100 >= required
}

/**
 * Judge one coverage report.
 * @param {Record<string, object>} report - the istanbul file map (absolute paths).
 * @param {string} root - the repo root.
 * @returns {{ problems: string[], exempt: string[], global: Record<string, {covered: number, total: number}> }} the verdict.
 */
export function judge(report, root = ROOT) {
  const problems = []
  const exempt = []
  const global = { lines: { covered: 0, total: 0 }, statements: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } }
  const rest = { lines: { covered: 0, total: 0 }, statements: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } }
  for (const [file, entry] of Object.entries(report)) {
    const shown = relative(root, file).split('\\').join('/')
    const totals = totalsOf(entry)
    for (const key of Object.keys(global)) {
      global[key].covered += totals[key].covered
      global[key].total += totals[key].total
    }
    if (!CORE_SCOPE.test(shown)) {
      for (const key of Object.keys(rest)) {
        rest[key].covered += totals[key].covered
        rest[key].total += totals[key].total
      }
      continue
    }
    const excused = EXEMPT.find(item => item.scope.test(shown))
    if (excused !== undefined) { exempt.push(`${shown} — ${excused.reason}`); continue }
    for (const key of ['lines', 'statements', 'functions', 'branches']) {
      if (!meets(totals[key], 100)) {
        const pct = totals[key].total === 0 ? 100 : (totals[key].covered / totals[key].total) * 100
        problems.push(`${shown}: ${key} ${pct.toFixed(2)}% < 100% (${totals[key].covered}/${totals[key].total})`)
      }
    }
  }
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    if (!meets(global[key], FLOOR[key])) {
      const pct = global[key].total === 0 ? 100 : (global[key].covered / global[key].total) * 100
      problems.push(`all files: ${key} ${pct.toFixed(2)}% < floor ${FLOOR[key]}%`)
    }
    if (!meets(rest[key], REST_FLOOR[key])) {
      const pct = rest[key].total === 0 ? 100 : (rest[key].covered / rest[key].total) * 100
      problems.push(`non-core files: ${key} ${pct.toFixed(2)}% < floor ${REST_FLOOR[key]}%`)
    }
  }
  return { problems, exempt, global }
}

function main() {
  const dir = resolve(process.argv[2] ?? join(ROOT, 'coverage'))
  let report
  try {
    report = JSON.parse(readFileSync(join(dir, 'coverage-final.json'), 'utf8'))
  } catch (error) {
    console.error(`coverage-policy: no readable report in ${dir} (${String(error.message ?? error)})`)
    console.error('  run: pnpm run test:coverage')
    process.exit(1)
  }
  const { problems, exempt, global } = judge(report)
  const pct = (metric) => (metric.total === 0 ? '100.00' : ((metric.covered / metric.total) * 100).toFixed(2))
  console.log(`coverage-policy: all files lines ${pct(global.lines)}% · statements ${pct(global.statements)}% · functions ${pct(global.functions)}% · branches ${pct(global.branches)}%`
    + ` (floor ${FLOOR.lines}/${FLOOR.statements}/${FLOOR.functions}/${FLOOR.branches})`)
  for (const entry of exempt) console.log(`  EXEMPT ${entry}`)
  if (problems.length === 0) {
    console.log('coverage-policy: OK')
    return
  }
  console.error(`coverage-policy: FAIL — ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
