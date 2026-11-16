#!/usr/bin/env node
/**
 * Client peer-shape gate (dsh-conformance 批 G, finding
 * client-workspace-peers-browser-type-only): every `packages/client/*`
 * plugin package (manifest declares `dsh.client`) may declare only Cordis in
 * `peerDependencies`. Browser and type relationships (client imports,
 * type-only imports, project references, `dsh.client.inject`) belong in
 * `devDependencies` — a peer asserts a runtime
 * identity the consumer must share, and a workspace peer of a type-only edge
 * breaks npm consumption and contradicts the platform dependency policy
 * (packages/client/AGENTS.md rule 3). A future legitimate peer (a
 * `peerRequiredHostExports` value edge) is added to the allowlist below
 * deliberately, never ad-hoc. `--self-test` runs the checker against
 * synthetic fixtures and must trip it.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The only peers a client plugin package may declare (Cordis; a deliberate value seam joins this list with the commit that adds it). */
const ALLOWED_PEERS = new Set(['@deepseek-ai/cordis'])

/** Collect `{ packageName -> peerDependencies }` for every `packages/client/*` package declaring `dsh.client`. */
export function collectClientPluginPeers(root) {
  const clientDir = join(root, 'packages', 'client')
  const declared = new Map()
  if (!existsSync(clientDir)) return declared
  for (const dir of readdirSync(clientDir)) {
    const pkgPath = join(clientDir, dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (manifest.dsh?.client === undefined) continue
    declared.set(manifest.name, Object.keys(manifest.peerDependencies ?? {}))
  }
  return declared
}

/** The peer-shape problems of one tree (exported for the script-plane tests: the
 * scaffolder's own products must pass the gate that ships beside it, AR2 ③). */
export function checkPeerShape(root) {
  const declared = collectClientPluginPeers(root)
  const problems = []
  for (const [name, peers] of declared) {
    for (const peer of peers) {
      if (!ALLOWED_PEERS.has(peer)) {
        problems.push(`${name}: declares peer ${JSON.stringify(peer)} — client plugin peers are Cordis-only (browser/type edges belong in devDependencies; a deliberate value seam joins the gate's allowlist)`)
      }
    }
  }
  return problems
}

function selfTest() {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-peer-shape-selftest-'))
  try {
    for (const [label, peers, pattern] of [
      ['bad-peer', { '@matrix1001/dsh-application-harness-x': 'workspace:*' }, /Cordis-only/],
      ['good-peers', { '@deepseek-ai/cordis': '^4.0.1' }, null],
    ]) {
      const root = join(dest, label.replace(/\s+/g, '-'))
      const dir = join(root, 'packages', 'client', 'pkg')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@matrix1001/dsh-application-harness-pkg',
        dsh: { client: { platform: 'web' } },
        peerDependencies: peers,
      }))
      const problems = checkPeerShape(root)
      if (pattern === null ? problems.length !== 0 : !problems.some(p => pattern.test(p))) {
        throw new Error(`self-test "${label}" did not trip the checker (got: ${problems.join('; ') || 'no problems'})`)
      }
    }
    console.log(`  ✓ 2 self-tests all trip the checker`)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  console.log('verify-client-peer-shape: client plugin peerDependencies are Cordis-only')
  const problems = checkPeerShape(ROOT)
  for (const problem of problems) console.error(`  ✘ ${problem}`)
  const declaredCount = collectClientPluginPeers(ROOT).size
  if (problems.length > 0) {
    console.error(`verify-client-peer-shape: ${problems.length} peer drift(s) — move browser/type edges to devDependencies, or add a deliberate value seam to the gate's allowlist`)
    process.exit(1)
  }
  console.log(`verify-client-peer-shape: ${declaredCount} client plugin packages — in sync`)
}

// Importable for the script tests without executing the gate.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
