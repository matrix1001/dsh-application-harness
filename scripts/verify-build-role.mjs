#!/usr/bin/env node
/**
 * build-role hygiene gate (origin: the pre-2026-09-13 platform-hygiene backlog,
 * items `#5` "platform peer audit" and part of `#19` "platform hygiene gates";
 * `#5` landed in `b6bd5eb`, and that backlog now lives only in git history;
 * reworked 2026-09-02: bundle
 * children are peers, never dependencies; extended 2026-09-05 dsh-conformance
 * 批 A: dev-mirror and cordis same-range checks, and the platform peer union
 * derivation now also admits the client browser faces the children declare
 * dev-only; reworked 2026-09-08 批 H: platform pins live in the bundle's
 * `dependencies` — the platform bundle shape, so the platform-closure check
 * covers peers ∪ dependencies. Platform 0.1.6-alpha.2 made `runtime` the
 * launcher's default resolution mode: those pins are supplied by an in-process
 * resolution generation and no fallback links are materialized, so the former
 * link-mode "healed node_modules fallback" is no longer the path rows resolve
 * through — the pins stay in `dependencies` regardless).
 *
 * The `application-harness` bundle is the single install entry. Its children are the
 * workspace packages its patch rows mount — declared as
 * `@matrix1001/dsh-application-harness-*` in the bundle's `dependencies`, because a
 * published bundle is installed by `dsh plugin add` and the profile's
 * `autoInstallPeers: false` means peer declarations would never be installed.
 * The workspace source uses `workspace:*`; `pnpm publish`/`pnpm pack` rewrite
 * it to the release version. In the development profile every package is a
 * `link:`, whose own dependencies pnpm ignores, so the same manifest serves
 * both modes without a second distribution package. The bundle must also
 * declare every platform package its rowset requires — the children's
 * host-side platform peers always, and the platform browser edges the client
 * children use, which per the platform client contract ("browser and type
 * relationships are development-only") are declared in the children's
 * `devDependencies`, never in their peers.
 *
 * Rules enforced here (pure node over the workspace's `package.json` files, no
 * install, so it can live in `release:check` alongside publint):
 *
 *   0. Children are `dependencies`, never `peerDependencies` (a profile with
 *      `autoInstallPeers: false` does not install peers).
 *   1. Every bundle child must be a real workspace package.
 *   2. Every platform (non application-harness-*) peer of a child — and every platform
 *      edge a child declares in devDependencies (browser faces, the justification
 *      for the bundle's extra install-surface platform pins) — must be declared
 *      in the bundle's peerDependencies or dependencies; conversely every
 *      bundle platform declaration must be required by at least one child, in
 *      its peerDependencies or its devDependencies. A child's application-harness-*
 *      peer must be a bundle child.
 *   3. Every workspace `@matrix1001/dsh-application-harness*` package mirrors every
 *      `@deepseek-ai/dsh-*` peer in devDependencies with the same version string
 *      ("Mirror every dsh peer dependency in devDependencies").
 *   4. Every workspace `@matrix1001/dsh-application-harness*` package declares cordis in
 *      peerDependencies and devDependencies with the same range string.
 *   5. Every bundle-patch row must mount a declared child, and every child must
 *      be mounted by a row or required by another child — including the
 *      `dsh.appRow`-generated application/view rows, because they too must be
 *      installed by the bundle.
 *
 * Failed checks exit non-zero and print which platform pin is missing / which
 * child is unresolved / which declared pin is unused.
 *
 * @module scripts/verify-build-role
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { childRowProblems, patchRowsOf } from './descriptor-rows.mjs'
import { packageDirs } from './package-areas.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUNDLE = path.join(root, 'packages/bundle/app-harness/package.json')
const PATCH = path.join(root, 'packages/bundle/app-harness/cordis.patch.yml')
const CHILD_PREFIX = '@matrix1001/dsh-application-harness-'

/** Map every package's `name` to its package.json path. */
function scanPackageNames() {
  const names = new Map()
  for (const dir of packageDirs(root)) {
    const pkgPath = path.join(dir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (pkg.name) names.set(pkg.name, pkgPath)
  }
  return names
}

const errors = []
const names = scanPackageNames()
const bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'))
const allPeers = Object.keys(bundle.peerDependencies ?? {})
const bundled = Object.keys(bundle.dependencies ?? {})
const children = bundled.filter((name) => name.startsWith(CHILD_PREFIX)).sort()
// Platform pins: peers (cordis — the shared identity) plus dependencies (the
// platform rows and install-surface pins the children require).
const platformPins = [...allPeers.filter((name) => !name.startsWith(CHILD_PREFIX)), ...bundled.filter((name) => !name.startsWith(CHILD_PREFIX))].sort()

// 0. Children must be dependencies, never peers: the platform profile sets
//    autoInstallPeers: false, so a peer child would never be installed by
//    `dsh plugin add`.
const forbidden = allPeers.filter((name) => name.startsWith(CHILD_PREFIX))
if (forbidden.length > 0) errors.push(`bundle declares application-harness-* as peerDependencies (move to dependencies): ${forbidden.join(', ')}`)

// 1. Every bundle child must be a real workspace package.
for (const child of children) {
  if (!names.has(child)) errors.push(`bundle child "${child}" is not a resolvable workspace package`)
}

// 2. The bundle's platform declarations must cover the children's platform
//    peer closure (host runtime needs) and every platform edge the children
//    declare in devDependencies (client browser faces, which justify the
//    bundle's install-surface pins); an application-harness-* peer of a child must be
//    a bundle child itself.
const union = new Set()
const childEdges = new Map()
/** Children some other child declares as a peer (the logical `ledger` contract is shared, never mounted). */
const childReferenced = new Set()
for (const child of children) {
  const pkgPath = names.get(child)
  if (!pkgPath) continue
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
    if (peer.startsWith(CHILD_PREFIX)) {
      if (!children.includes(peer)) {
        errors.push(`child "${child}" peers "${peer}" which the bundle does not declare (add it to the bundle's dependencies)`)
      }
      childReferenced.add(peer)
      continue
    }
    union.add(peer)
    childEdges.set(peer, child)
  }
  for (const dep of Object.keys(pkg.devDependencies ?? {})) {
    if (dep.startsWith(CHILD_PREFIX)) continue
    if (!childEdges.has(dep)) childEdges.set(dep, child)
  }
}
const unionSorted = [...union].sort()
const notAggregated = platformPins.filter((p) => !childEdges.has(p))
const untracked = unionSorted.filter((p) => !platformPins.includes(p))

if (children.length === 0) errors.push('bundle declares no @matrix1001/dsh-application-harness-* children in dependencies')
if (notAggregated.length > 0) {
  errors.push(`bundle declares platform packages required by no child (remove or reparent): ${notAggregated.join(', ')}`)
}
if (untracked.length > 0) {
  errors.push(`children require platform peers the bundle does not declare (add to dependencies): ${untracked.join(', ')}`)
}

// 3. Every workspace application-harness package mirrors every dsh platform peer in
//    devDependencies with the same version string.
// 4. cordis must appear in peerDependencies and devDependencies with the same
//    range string.
const harnessPackages = [...names]
  .filter(([name]) => name.startsWith(CHILD_PREFIX) || name === '@matrix1001/dsh-application-harness')
  .map(([name, pkgPath]) => [name, JSON.parse(fs.readFileSync(pkgPath, 'utf8'))])

for (const [name, pkg] of harnessPackages) {
  const peers = pkg.peerDependencies ?? {}
  const devs = pkg.devDependencies ?? {}
  for (const [peer, range] of Object.entries(peers)) {
    if (!peer.startsWith('@deepseek-ai/dsh-')) continue
    const mirror = devs[peer]
    if (mirror === undefined) {
      errors.push(`"${name}" peers "${peer}" without a devDependencies mirror (mirror every dsh peer dependency in devDependencies)`)
    } else if (mirror !== range) {
      errors.push(`"${name}" peer/dev mirror mismatch for "${peer}": peer "${range}" vs dev "${mirror}" (same version string)`)
    }
  }
  // The cordis declaration is UNCONDITIONAL, not "when present, the ranges must
  // match": the platform's own utility packages declare it in both sections even
  // though they never import it (16/16 in the checkout), and a package that
  // imports nothing from cordis today is one edit away from needing it. Making
  // the rule total is what lets it be checked mechanically rather than argued
  // case by case (dsh-conformance 2026-09-23, batch 5: `application-harness-cli` was the
  // repository's only package with neither section — the previous form of this
  // check could not see it).
  const cordisPeer = peers['@deepseek-ai/cordis']
  const cordisDev = devs['@deepseek-ai/cordis']
  if (cordisPeer === undefined) errors.push(`"${name}" does not declare @deepseek-ai/cordis in peerDependencies`)
  if (cordisDev === undefined) errors.push(`"${name}" does not declare @deepseek-ai/cordis in devDependencies`)
  if (cordisPeer !== undefined && cordisDev !== undefined && cordisPeer !== cordisDev) {
    errors.push(`"${name}" @deepseek-ai/cordis peer (${cordisPeer}) and dev (${cordisDev}) ranges must match`)
  }
}

// 5. Every row the bundle manifest OWNS must name a declared child, and every
//    child must be mounted by one of those rows or required by a child that is.
//    "Owns" = every row except the ones generated from `dsh.appRow`: those
//    applications and client views are the deployment descriptor's single
//    declaration, compared by verify-deployment-descriptor.mjs (arch-review
//    2026-09-19; DA2: the `app-health` row was mounted while the package sat in
//    neither peerDependencies nor devDependencies — only the workspace `link:`
//    scan hid it).
const patchRows = patchRowsOf(fs.readFileSync(PATCH, 'utf8'))
errors.push(...childRowProblems({ rows: patchRows, children, self: bundle.name, childPrefix: CHILD_PREFIX, referenced: [...childReferenced] }))

if (errors.length > 0) {
  console.error('verify-build-role: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`verify-build-role: OK — ${children.length} children, ${patchRows.length} patch rows, ${unionSorted.length} child platform peers, ${platformPins.length} bundle platform pins (peers+deps), ${harnessPackages.length} application-harness packages checked`)
