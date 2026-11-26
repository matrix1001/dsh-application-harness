#!/usr/bin/env node
/**
 * Print one clickable location per uncovered statement, branch path and
 * function from the istanbul JSON report.
 *
 * Vitest's per-file threshold failure names only the file; this prints the
 * exact `path:line:col` lines just above those errors, so "which line is
 * missing a test" needs no HTML report. Files at 100% print nothing.
 *
 * Usage: node scripts/uncovered-locations.mjs [coverageDir] [--filter <substr>]
 * @module scripts/uncovered-locations
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every uncovered location of one istanbul file entry.
 * @param {string} file - the absolute file path.
 * @param {object} entry - the istanbul coverage entry.
 * @returns {{ file: string, line: number, column: number, kind: string, detail: string }[]} the locations.
 */
export function uncoveredLocations(file, entry) {
  const out = []
  for (const [id, count] of Object.entries(entry.s ?? {})) {
    if (count > 0) continue
    const loc = entry.statementMap?.[id]
    if (loc === undefined || !Number.isFinite(loc.start?.line)) continue
    out.push({ file, line: loc.start.line, column: loc.start.column + 1, kind: 'statement', detail: '' })
  }
  for (const [id, count] of Object.entries(entry.f ?? {})) {
    if (count > 0) continue
    const loc = entry.fnMap?.[id]?.loc
    if (loc === undefined || !Number.isFinite(loc.start?.line)) continue
    out.push({ file, line: loc.start.line, column: loc.start.column + 1, kind: 'function', detail: entry.fnMap[id]?.name ?? '' })
  }
  for (const [id, counts] of Object.entries(entry.b ?? {})) {
    const branch = entry.branchMap?.[id]
    if (branch === undefined) continue
    counts.forEach((count, index) => {
      if (count > 0) return
      const loc = branch.locations?.[index]
      if (loc === undefined || !Number.isFinite(loc.start?.line)) {
        if (Number.isFinite(branch.loc?.start?.line)) {
          out.push({ file, line: branch.loc.start.line, column: (branch.loc.start.column ?? 0) + 1, kind: 'branch', detail: `${branch.type} path ${index + 1}/${counts.length}` })
        }
        return
      }
      out.push({ file, line: loc.start.line, column: loc.start.column + 1, kind: 'branch', detail: `${branch.type} path ${index + 1}/${counts.length}` })
    })
  }
  return out.sort((left, right) => left.line - right.line || left.column - right.column || left.kind.localeCompare(right.kind))
}

/**
 * Read a coverage directory's `coverage-final.json`.
 * @param {string} dir - the reports directory.
 * @returns {Record<string, object>} the istanbul file map.
 * @throws when the report is missing or unreadable.
 */
export function readCoverage(dir) {
  const path = join(dir, 'coverage-final.json')
  if (!existsSync(path)) throw new Error(`no coverage report at ${path} — run vitest with --coverage.reporter=json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main() {
  const args = process.argv.slice(2)
  const filterAt = args.indexOf('--filter')
  const filter = filterAt === -1 ? undefined : args[filterAt + 1]
  const dir = resolve(args.find(arg => !arg.startsWith('--') && arg !== filter) ?? join(ROOT, 'coverage'))
  let report
  try {
    report = readCoverage(dir)
  } catch (error) {
    console.error(`uncovered-locations: ${String(error.message ?? error)}`)
    process.exit(1)
  }
  let total = 0
  for (const [file, entry] of Object.entries(report)) {
    const shown = relative(ROOT, file).split('\\').join('/')
    if (filter !== undefined && !shown.includes(filter)) continue
    const locations = uncoveredLocations(file, entry)
    if (locations.length === 0) continue
    for (const location of locations) {
      total += 1
      console.log(`${shown}:${location.line}:${location.column}  ${location.kind}${location.detail === '' ? '' : ` (${location.detail})`}`)
    }
  }
  if (total === 0) console.log('uncovered-locations: every location is covered')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
