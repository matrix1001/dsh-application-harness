#!/usr/bin/env node
/**
 * Every `v8 ignore` comment must say why.
 *
 * An ignore is a written promise that the code cannot or need not run. Making
 * the reason mandatory turns that promise into something a reviewer can judge,
 * and keeps the count honest. Paired markers (`stop`/`end`) are exempt: the
 * reason belongs to the matching `start` (or the `next` it closes).
 *
 * Usage: node scripts/check-ignore-reasons.mjs
 * @module scripts/check-ignore-reasons
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AREAS = ['packages', 'apps']

/** Collect source files under the measured areas (src and tests). */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) { sourceFiles(abs, out); continue }
    if (/\.[cm]?tsx?$/u.test(entry.name)) out.push(abs)
  }
  return out
}

/**
 * The ignore comments in one file that carry no reason.
 * @param {string} file - the absolute path.
 * @param {string} text - the file text.
 * @returns {{ line: number, text: string }[]} the offenders.
 */
export function unreasonedIgnores(file, text) {
  const out = []
  text.split('\n').forEach((line, index) => {
    const at = line.indexOf('v8 ignore')
    if (at === -1) return
    const rest = line.slice(at + 'v8 ignore'.length).trim()
    // `stop` / `end` close a marked region; the reason lives on the opener.
    if (/^(stop|end)\b/u.test(rest)) return
    if (/\s--\s/u.test(rest)) return
    out.push({ line: index + 1, text: line.trim() })
  })
  return out
}

function main() {
  const problems = []
  let files = 0
  let ignores = 0
  for (const area of AREAS) {
    const base = join(ROOT, area)
    if (!statSync(base).isDirectory()) continue
    for (const file of sourceFiles(base)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('v8 ignore')) continue
      files += 1
      ignores += (text.match(/v8 ignore/gu) ?? []).length
      for (const offender of unreasonedIgnores(file, text)) {
        problems.push(`${relative(ROOT, file).split('\\').join('/')}:${offender.line}  ${offender.text}`)
      }
    }
  }
  console.log(`check-ignore-reasons: ${ignores} ignore(s) in ${files} file(s)`)
  if (problems.length === 0) return
  console.error(`check-ignore-reasons: FAIL — ${problems.length} ignore(s) carry no reason (add " -- <why>")`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
