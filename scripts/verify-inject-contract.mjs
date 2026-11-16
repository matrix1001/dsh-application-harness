#!/usr/bin/env node
/**
 * Inject/external contract gate (dsh-web #6, 共识 2 补强; 批 G — external
 * 半加入): every client package's `dsh.client.inject` declaration (the
 * informational package-name edges) and `dsh.client.external` declaration
 * (the exact module-table value requests) are compared bidirectionally
 * against a frozen list (`scripts/inject-contract.json`) — a declared edge
 * absent from the list, a listed edge no longer declared anywhere, or a list
 * entry whose package is gone all fail the gate. The platform-bump port
 * updates the list deliberately (it IS the port's checklist); drift outside
 * a port is exactly the silent injection-surface change this gate catches at
 * CI time instead of the user's boot. `--self-test` runs the checker against
 * synthetic fixture manifests and must trip it.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT_PATH = join(ROOT, 'scripts', 'inject-contract.json')

/** Collect `{ packageName -> edges[] }` for every workspace package declaring the given `dsh.client` key. */
function collect(root, key) {
  const declared = new Map()
  for (const group of ['application', 'client', 'examples', 'bundle']) {
    const groupDir = join(root, 'packages', group)
    if (!existsSync(groupDir)) continue
    for (const dir of readdirSync(groupDir)) {
      const pkgPath = join(groupDir, dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const edges = manifest.dsh?.client?.[key]
      if (edges === undefined) continue
      declared.set(manifest.name, edges)
    }
  }
  return declared
}

/** Compare declarations vs the frozen contract for one dsh.client key; returns problem strings. */
function checkContract(root, contract, key) {
  const declared = collect(root, key)
  const problems = []
  const contractNames = new Set(Object.keys(contract))
  for (const [name, edges] of declared) {
    if (!contractNames.has(name)) {
      problems.push(`${name}: declares dsh.client.${key} but is absent from the frozen contract`)
      continue
    }
    const frozen = [...contract[name]]
    const declaredList = [...edges]
    for (const edge of declaredList) {
      if (!frozen.includes(edge)) problems.push(`${name}: declares ${JSON.stringify(edge)} in ${key} — not in the frozen contract`)
    }
    for (const edge of frozen) {
      if (!declaredList.includes(edge)) problems.push(`${name}: contract lists ${JSON.stringify(edge)} in ${key} — no longer declared`)
    }
  }
  for (const name of contractNames) {
    if (!declared.has(name)) problems.push(`${name}: contract ${key} entry exists but the package is gone or declares no dsh.client.${key}`)
  }
  return problems
}

function selfTest() {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-inject-selftest-'))
  const cases = [
    ['undeclared-seam', '@deepseek-ai/a', ['@deepseek-ai/c'], { '@deepseek-ai/a': ['@deepseek-ai/b'] }, /not in the frozen contract/],
    ['missing-seam', '@deepseek-ai/a', ['@deepseek-ai/b'], { '@deepseek-ai/a': ['@deepseek-ai/b', '@deepseek-ai/c'] }, /no longer declared/],
    ['missing-package', '@deepseek-ai/a', [], { '@deepseek-ai/ghost': ['@deepseek-ai/b'] }, /package is gone/],
    ['undeclared-package', '@deepseek-ai/a', ['@deepseek-ai/b'], {}, /absent from the frozen contract/],
  ]
  try {
    for (const [label, name, inject, contract, pattern] of cases) {
      const root = join(dest, label.replace(/\s+/g, '-'))
      const dir = join(root, 'packages', 'client', 'pkg')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name,
        dsh: { client: { inject } },
      }))
      const problems = checkContract(root, contract, 'inject')
      if (!problems.some((p) => pattern.test(p))) {
        throw new Error(`self-test "${label}" did not trip the checker (got: ${problems.join('; ') || 'no problems'})`)
      }
    }
    // The external half: any module-table value request must appear in the
    // frozen list (empty today) — an ad-hoc edge fails the gate.
    const extRoot = join(dest, 'external')
    const extDir = join(extRoot, 'packages', 'client', 'pkg')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/a',
      dsh: { client: { external: ['@matrix1001/dsh-application-harness-x/client'] } },
    }))
    const extProblems = checkContract(extRoot, { '@deepseek-ai/a': ['@matrix1001/dsh-application-harness-y/client'] }, 'external')
    if (!extProblems.some((p) => /not in the frozen contract/.test(p))) {
      throw new Error(`external self-test did not trip the checker (got: ${extProblems.join('; ') || 'no problems'})`)
    }
    console.log(`  ✓ 5 self-tests all trip the checker`)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  console.log('verify-inject-contract: declared dsh.client.inject/external edges vs the frozen contract')
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
  let problems = []
  for (const key of ['inject', 'external']) {
    const section = contract[key]
    if (section === undefined || typeof section !== 'object') {
      problems.push(`contract file is missing the ${JSON.stringify(key)} section`)
      continue
    }
    problems = problems.concat(checkContract(ROOT, section, key))
  }
  for (const problem of problems) console.error(`  ✘ ${problem}`)
  const declaredCount = collect(ROOT, 'inject').size
  const externalCount = collect(ROOT, 'external').size
  if (problems.length > 0) {
    console.error(`verify-inject-contract: ${problems.length} drift(s) — update scripts/inject-contract.json as part of a deliberate platform port, never ad-hoc`)
    process.exit(1)
  }
  console.log(`verify-inject-contract: ${declaredCount} inject-declaring packages, ${externalCount} external-declaring packages — in sync`)
}

main()
