#!/usr/bin/env node
/**
 * Profile-shape single-source gate (2026-09-07 official-channel migration,
 * superseding the old machinery-extraction check): `scripts/setup.mjs` must
 * generate the official-channel profile shape — (a) the manifest declares
 * `@matrix1001/dsh-application-harness` among `dsh.profile.bundles` (the bundle layer
 * carries the machinery + generated application rows; `generate-bundle-patch
 * .mjs --check` guards that aggregation) and (b) the patch layer a FRESH
 * profile gets is the empty user layer (no `- insert:` — rows no longer get
 * copied into the profile patch). Runs `setup.mjs --dry-run` into a scratch
 * directory, so both halves are about a profile being created, not about an
 * existing one: since platform 0.1.7-alpha.1 an existing profile's
 * `cordis.patch.yml` is the platform's own settings document, which setup
 * preserves and this gate deliberately says nothing about.
 * @module
 */

import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const generated = execFileSync(process.execPath, [join(ROOT, 'scripts/setup.mjs'), '--dry-run'], { cwd: ROOT, encoding: 'utf8' })

const manifestHeader = '# --- package.json ---\n'
const patchHeader = '# --- cordis.patch.yml ---\n'
const manifestStart = generated.indexOf(manifestHeader)
const patchStart = generated.indexOf(patchHeader)
if (manifestStart === -1 || patchStart === -1) {
  console.error('verify-machinery-rows: setup.mjs --dry-run output shape changed (missing package.json / cordis.patch.yml sections)')
  process.exit(1)
}
const manifestEnd = generated.indexOf('\n# --- ', manifestStart + manifestHeader.length)
const manifest = JSON.parse(generated.slice(manifestStart + manifestHeader.length, manifestEnd === -1 ? patchStart : manifestEnd).trim())
const bundles = manifest.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.includes('@matrix1001/dsh-application-harness')) {
  console.error('verify-machinery-rows: the profile manifest does not declare @matrix1001/dsh-application-harness among dsh.profile.bundles — the bundle layer would carry no rows')
  process.exit(1)
}
const patchText = generated.slice(patchStart + patchHeader.length)
if (patchText.includes('- insert:')) {
  console.error('verify-machinery-rows: the patch a fresh profile gets is not the empty user layer — rows must live in the bundle patch (packages/bundle/app-harness/cordis.patch.yml), not the profile patch')
  process.exit(1)
}
console.log('verify-machinery-rows: OK — setup.mjs generates the official-channel profile shape (bundle layer + empty user patch on a fresh profile)')
