#!/usr/bin/env node
/**
 * Bundle-free Typert generation (platform rc.2's `generate-typert` shape).
 *
 * The generator writes every contributor's `lib/typert.host.*` and
 * `lib/typert.remote-client.*` from source, before any bundling. That removes
 * the old writeBundle ordering: the client pass used to inline the PREVIOUS
 * generation's wire contract and could ship a mirror bundle whose plugin
 * failed to activate (2026-09-16). Running this pass first means `tsdown` only
 * bundles JavaScript, and the client bundles inline the current contract.
 *
 * The generator is the published `@deepseek-ai/dsh-typert-generator` installed
 * in `node_modules` — the same package CI, the daily build and a release use,
 * so the emitted faces cannot follow a second line.
 *
 * Usage: `node scripts/generate-typert.mjs` from the repository root.
 * @module scripts/generate-typert
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findWorkspaceRoot, WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The workspace's only Typert face: Host reflection + the Host-for-Client Remote projection. */
const FACES = ['host']

/**
 * Host package compilation owns TypeScript diagnostics and runs before this
 * pass. This workspace's project-reference graph resolves cross-package types
 * through built declarations (adding source `paths` for every edge would create
 * project cycles), so the strict `rejectBuildOutputs` check is off; the pass
 * still generates every artifact from source before `tsdown` runs.
 */
const OPTIONS = { checkDiagnostics: false }

/** Render a failure with its stage and next action. */
function report(error) {
  const cause = error?.cause ?? error
  const detail = cause?.name === 'TypertAnalysisError' || cause?.name === 'TypertEmitError'
    ? `${cause.name}: ${cause.message}`
    : (cause?.stack ?? String(cause))
  console.error(`generate-typert: Typert generation failed\n  ${detail.replaceAll('\n', '\n  ')}`)
}

function main() {
  const root = findWorkspaceRoot(ROOT)
  const artifacts = new WorkspaceTypertGenerator(root, OPTIONS).generateContributors(FACES)
  writeWorkspaceArtifacts(root, artifacts)
  const packages = new Set(artifacts.map((artifact) => artifact.package)).size
  console.log(`generate-typert: wrote ${artifacts.length} Typert artifact(s) for ${packages} package(s)`)
}

try {
  main()
} catch (error) {
  report(error)
  process.exitCode = 1
}
