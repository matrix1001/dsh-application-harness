#!/usr/bin/env node
/**
 * The visual-scale gate: every size in the client's CSS modules comes from the
 * shared tokens in `packages/client/applications/src/client/tokens.module.css`.
 *
 * Why a gate and not a review habit: the scale used to be declared (13 custom
 * properties on the app area) and ignored — 247 literal `font-size` values and
 * 282 literal `gap` values against 13 variable reads, with 20 sizes outside the
 * declared five-tier scale. The declarations alone changed nothing; this check
 * is what keeps a new rule from introducing a fourth title size.
 *
 * Hard failures (the rule is already in force):
 * - a literal `font-size: <n>px` (use `var(--app-font-*)`, or `em` for a label
 *   that must scale with its container);
 * - a literal `gap` / `row-gap` / `column-gap` (use `var(--app-space-*)`).
 *
 * Soft reports (the migration is still in flight; `--strict` turns them into
 * failures):
 * - literal `line-height: <n>px` — the three ratios replace them once the
 *   fixed-height components are converted;
 * - a media/container breakpoint other than the two agreed ones (720 / 1040).
 *
 * Usage: node scripts/verify-app-scale.mjs [--strict]
 * @module
 */

import { globSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.argv.includes('--strict')
const TOKENS = resolve(ROOT, 'packages/client/applications/src/client/tokens.module.css')
const BREAKPOINTS = new Set(['720', '1040'])

/** Every source CSS module (never a dependency's copy). */
export function clientStylesheets() {
  return [
    ...globSync('packages/client/*/src/**/*.module.css', { cwd: ROOT, absolute: true }),
    ...globSync('apps/*/view/src/**/*.module.css', { cwd: ROOT, absolute: true }),
  ]
    .filter(file => !file.includes(`${'/'}node_modules${'/'}`))
}

/**
 * Check one stylesheet's text.
 * @param text - the file's contents.
 * @returns the hard failures and soft reports, as `line: message` strings.
 */
export function checkStylesheet(text) {
  const fail = []
  const warn = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const at = index + 1
    if (line.includes('scale-exempt')) return
    if (/font-size:\s*[0-9.]+px/.test(line) && !line.includes('/*')) {
      fail.push(`${at}: literal font-size — use var(--app-font-*) or em`)
    }
    if (/\b(gap|row-gap|column-gap):\s*[0-9]+px/.test(line) && !line.includes('/*')) {
      fail.push(`${at}: literal gap — use var(--app-space-*)`)
    }
    if (/line-height:\s*[0-9.]+px/.test(line) && !line.includes('/*')) {
      warn.push(`${at}: literal line-height — convert to var(--app-line-*)`)
    }
    const media = /@(media|container)[^{]*\(m(?:ax|in)-width:\s*([0-9]+)px\)/.exec(line)
    if (media !== null && !BREAKPOINTS.has(media[2])) {
      warn.push(`${at}: breakpoint ${media[2]}px — only 720 / 1040 survive`)
    }
  })
  return { fail, warn }
}

/**
 * Run the gate over the workspace.
 * @returns the exit code (0 clean, 1 violations).
 */
export function main() {
  const failures = []
  const warnings = []
  for (const file of clientStylesheets()) {
    if (file === TOKENS) continue
    const { fail, warn } = checkStylesheet(readFileSync(file, 'utf8'))
    for (const line of fail) failures.push(`${relative(ROOT, file)}:${line}`)
    for (const line of warn) warnings.push(`${relative(ROOT, file)}:${line}`)
  }
  for (const line of warnings) process.stdout.write(`[app-scale] warn  ${line}\n`)
  for (const line of failures) process.stderr.write(`[app-scale] FAIL  ${line}\n`)
  process.stdout.write(`[app-scale] ${failures.length} failures, ${warnings.length} warnings\n`)
  if (failures.length > 0) return 1
  if (STRICT && warnings.length > 0) return 1
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
