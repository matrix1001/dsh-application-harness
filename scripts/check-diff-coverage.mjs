#!/usr/bin/env node
/**
 * The new-code gate: the lines this change adds must be covered.
 *
 * Whole-tree percentages hide the case this gate exists for — a brand-new file
 * that no test imports, drowned by a 99% repository average. Coverage is
 * measured against the lines in `git diff <base>...HEAD`, so a change pays only
 * for what it touches:
 *
 * - instrumented locations that START on an added line are counted;
 * - an added line with no instrumented location (comment, blank, type-only) is
 *   ignored;
 * - files outside the coverage report are ignored (not measured by policy);
 * - the aggregate over all added lines must reach the threshold (default 90%).
 *
 * The base is diffed with two dots: this repository's `master` is a public
 * snapshot commit with no merge base against the development line, so the
 * tree-to-tree diff (everything that differs from the release) is the honest
 * "new code" question.
 *
 * Usage: node scripts/check-diff-coverage.mjs [--base <ref>] [--coverage <dir>]
 *                                             [--threshold <pct>]
 * @module scripts/check-diff-coverage
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse `git diff -U0` output into added line numbers per file.
 * @param {string} text - the diff text.
 * @returns {Map<string, Set<number>>} root-relative POSIX path → added lines.
 */
export function parseAddedLines(text) {
  const files = new Map()
  let current
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = line.slice('+++ b/'.length)
      files.set(current, new Set())
      continue
    }
    if (current === undefined) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (hunk === null) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    for (let offset = 0; offset < count; offset += 1) files.get(current).add(start + offset)
  }
  for (const [file, lines] of files) if (lines.size === 0) files.delete(file)
  return files
}

/**
 * Collect the instrumented locations of one istanbul entry that start on a set
 * of lines.
 * @param {object} entry - the istanbul coverage entry.
 * @param {Set<number>} lines - the changed line numbers.
 * @returns {{ covered: number, total: number }} the counts.
 */
export function countLocations(entry, lines) {
  let covered = 0
  let total = 0
  const hit = (loc) => Number.isFinite(loc?.start?.line) && lines.has(loc.start.line)
  for (const [id, loc] of Object.entries(entry.statementMap ?? {})) {
    if (!hit(loc)) continue
    total += 1
    if ((entry.s?.[id] ?? 0) > 0) covered += 1
  }
  for (const [id, loc] of Object.entries(entry.fnMap ?? {})) {
    if (!hit(loc?.loc)) continue
    total += 1
    if ((entry.f?.[id] ?? 0) > 0) covered += 1
  }
  for (const [id, counts] of Object.entries(entry.b ?? {})) {
    const branch = entry.branchMap?.[id]
    if (branch === undefined) continue
    counts.forEach((count, index) => {
      if (!hit(branch.locations?.[index] ?? branch.loc)) return
      total += 1
      if (count > 0) covered += 1
    })
  }
  return { covered, total }
}

/**
 * Judge changed lines against a coverage report.
 * @param {Record<string, object>} report - istanbul file map (absolute paths).
 * @param {Map<string, Set<number>>} files - changed files (root-relative).
 * @param {string} root - the repo root.
 * @param {number} threshold - the required percentage.
 * @returns {{ problems: string[], covered: number, total: number, files: { file: string, covered: number, total: number }[] }} the verdict.
 */
export function judgeDiff(report, files, root = ROOT, threshold = 90) {
  const byRelative = new Map()
  for (const [file, entry] of Object.entries(report)) byRelative.set(relative(root, file).split('\\').join('/'), entry)
  const problems = []
  const perFile = []
  let covered = 0
  let total = 0
  for (const [file, lines] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const entry = byRelative.get(file)
    if (entry === undefined) continue
    const counts = countLocations(entry, lines)
    if (counts.total === 0) continue
    perFile.push({ file, ...counts })
    covered += counts.covered
    total += counts.total
    if (counts.covered === 0) problems.push(`${file}: ${counts.total} changed location(s), none covered`)
  }
  const pct = total === 0 ? 100 : (covered / total) * 100
  if (total > 0 && pct < threshold) problems.push(`changed lines: ${pct.toFixed(2)}% < ${threshold}% (${covered}/${total})`)
  return { problems, covered, total, files: perFile }
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (flag, fallback) => {
    const index = args.indexOf(flag)
    return index === -1 ? fallback : args[index + 1]
  }
  const base = valueOf('--base', process.env.DIFF_BASE ?? 'origin/master')
  const dir = resolve(valueOf('--coverage', join(ROOT, 'coverage')))
  const threshold = Number(valueOf('--threshold', '90'))
  let diff
  try {
    diff = execFileSync('git', ['diff', '-U0', '--no-color', base, 'HEAD', '--', '.'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_COUNT: '0' },
    })
  } catch (error) {
    console.error(`diff-coverage: cannot diff against ${base} (${String(error.message ?? error)})`)
    console.error('  pass --base <ref> or set DIFF_BASE; CI needs fetch-depth: 0')
    process.exit(1)
  }
  let report
  try {
    report = JSON.parse(readFileSync(join(dir, 'coverage-final.json'), 'utf8'))
  } catch (error) {
    console.error(`diff-coverage: no readable report in ${dir} (${String(error.message ?? error)})`)
    process.exit(1)
  }
  const files = parseAddedLines(diff)
  const { problems, covered, total, files: perFile } = judgeDiff(report, files, ROOT, threshold)
  if (total === 0) {
    console.log(`diff-coverage: no instrumented lines changed against ${base} — nothing to judge`)
    return
  }
  const pct = ((covered / total) * 100).toFixed(2)
  console.log(`diff-coverage: ${files.size} changed file(s) against ${base} — ${covered}/${total} changed location(s) covered (${pct}%, threshold ${threshold}%)`)
  const worst = perFile.filter(entry => entry.covered / entry.total < threshold).sort((left, right) => left.covered / left.total - right.covered / right.total).slice(0, 10)
  for (const entry of worst) console.log(`  ${entry.file}: ${entry.covered}/${entry.total}`)
  if (problems.length === 0) {
    console.log('diff-coverage: OK')
    return
  }
  console.error(`diff-coverage: FAIL — ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
