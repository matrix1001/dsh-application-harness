#!/usr/bin/env node
/**
 * The official Client-plugin rule: a browser plugin must not load another
 * Harness Client package as a module. Type-only imports are erased at build
 * time and remain allowed; value/side-effect imports fail this gate.
 *
 * @module scripts/check-client-ui-imports
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AREAS = [join(ROOT, 'packages/client'), join(ROOT, 'apps')]

/** Collect production client sources under one area. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist' || entry.name === 'tests') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) { sourceFiles(abs, out); continue }
    if (['.ts', '.tsx', '.mts', '.mtsx'].includes(extname(entry.name))) out.push(abs)
  }
  return out
}

/**
 * Find value imports of Harness Client packages in one source text.
 * @param {string} file - path used in the report.
 * @param {string} text - source.
 * @returns {string[]} findings.
 */
export function clientValueImports(file, text) {
  const findings = []
  const from = /from\s+['"](@deepseek-ai\/dsh-client-[^'"]+)['"]/gu
  for (const match of text.matchAll(from)) {
    const at = match.index
    const start = text.lastIndexOf('import ', at)
    if (start === -1) continue
    const statement = text.slice(start, at)
    if (/^import\s+type\b/u.test(statement)) continue
    const braces = /\{([\s\S]*)\}/u.exec(statement)
    if (braces !== null) {
      const names = braces[1].split(',').map(name => name.trim()).filter(name => name !== '')
      if (names.every(name => name.startsWith('type '))) continue
    }
    findings.push(`${file}:${String(text.slice(0, at).split('\n').length)} value import from ${match[1]}`)
  }
  return findings
}

function main() {
  const findings = []
  let files = 0
  for (const area of AREAS) {
    const base = area.endsWith('/view') || area.endsWith('/client') ? area : area
    if (!statSync(base).isDirectory()) continue
    for (const file of sourceFiles(base)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('@deepseek-ai/dsh-client-')) continue
      files += 1
      findings.push(...clientValueImports(relative(ROOT, file).split('\\').join('/'), text))
    }
  }
  console.log(`check-client-ui-imports: ${files} production file(s) with Client type imports`)
  if (findings.length === 0) return
  console.error(`check-client-ui-imports: FAIL — ${findings.length} value import(s) from Harness Client packages`)
  for (const finding of findings) console.error(`  - ${finding}`)
  process.exit(1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
