#!/usr/bin/env node
/**
 * Deployment-descriptor gate (remediation plan 阶段 E 任务 5): the single
 * verifiable statement of a deployment's shape — level, platform line, service
 * set, application set, client capabilities, and execution sources — must
 * agree with the real composition. The descriptor DECLARES; the bundle patch,
 * the packages' `dsh.appRow` declarations, and the example compositions
 * IMPLEMENT; this gate proves the two sides have not drifted.
 *
 * Checks (all fail-closed):
 * 1. the descriptor parses and declares the Local level as implemented;
 * 2. every declared service row exists verbatim in the bundle patch (id + name),
 *    and every bundle-patch machinery row is declared (no undeclared row);
 * 3. every declared application matches a package's `dsh.appRow` id + name, and
 *    every `dsh.appRow` in the workspace is declared (the roster is DERIVED from
 *    those declarations, never listed — a fifth application enters the
 *    comparison by existing);
 * 4. the client-plugin rows and the declared client packages name each other
 *    (both directions), and every declared client package exists on disk with a
 *    client half;
 * 5. every declared execution composition exists;
 * 6. the profile shape the descriptor claims (bundle layer + empty user patch)
 *    is what `setup.mjs --dry-run` prints;
 * 7. **T4**: that generated profile satisfies the DECLARED platform line's own
 *    `initProfile` contract — the official sample is produced in a temp dir by
 *    the installed platform package (`@deepseek-ai/dsh-app-boot` at the
 *    declared version) and compared normalized (`compareProfileShape`). Our
 *    deliberate differences — dependency `link:` paths, the bundle list, the
 *    profile name, and comment text — are not drift. `dsh.profile.patchReload`
 *    is checked the other way round: it must be ABSENT on both sides, because
 *    the loader's template dropped the field in 0.1.6-alpha.2 (replacing a
 *    vocabulary comparison that normalized it to a default it then compared
 *    against itself, i.e. was vacuously true). No installed platform package
 *    matching the declared line is reported as UNVERIFIED, never as a pass.
 * @module
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { compareProfileShape, officialAppBoot, officialBundleLists } from './platform-contract.mjs'
import { appPackagesOf, appRosterProblems, clientRosterProblems, clientRowProblems, clientRowsOf, homeFileProblems, machineryRowProblems, machineryRowsOf, patchRowsOf, workspaceFileProblems } from './descriptor-rows.mjs'
import { packageDirs, packageDirsByName } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESCRIPTOR = join(ROOT, 'packages/bundle/app-harness/deployment.yml')
const PATCH = join(ROOT, 'packages/bundle/app-harness/cordis.patch.yml')
const problems = []

/** Read one file as UTF-8. */
function read(path) {
  return readFileSync(path, 'utf8')
}

/** Every workspace package that declares a client face (`dsh.client`) — the client roster's derivation source. */
function clientFacePackages() {
  const names = []
  for (const dir of packageDirs(ROOT)) {
    const manifest = JSON.parse(read(join(dir, 'package.json')))
    if (typeof manifest.name === 'string' && manifest.dsh?.client !== undefined) names.push(manifest.name)
  }
  return names
}

/** Every string value declared in any package's `dsh.appRow.config` (the workspace-file single sources). */
function appRowConfigValues() {
  const values = []
  for (const dir of packageDirs(ROOT)) {
    const manifest = JSON.parse(read(join(dir, 'package.json')))
    for (const value of Object.values(manifest.dsh?.appRow?.config ?? {})) {
      if (typeof value === 'string') values.push(value)
    }
  }
  return values
}

if (!existsSync(DESCRIPTOR)) {
  console.error('verify-deployment-descriptor: packages/bundle/app-harness/deployment.yml is missing')
  process.exit(1)
}
const descriptor = parseYaml(read(DESCRIPTOR))

// 1. the declared deployment level.
if (descriptor?.deployment?.level !== 'local') problems.push(`deployment.level must be "local" (got ${JSON.stringify(descriptor?.deployment?.level)})`)
if (descriptor?.deployment?.levels?.local?.implemented !== true) problems.push('deployment.levels.local.implemented must be true (the Local deployment is the shipped form)')

// 2. service rows vs the bundle patch. Only the MACHINERY rows are the
// descriptor's business: the client-plugin rows and the generated application
// rows are covered by checks 4 and 3 (their own single sources, each compared
// in BOTH directions there).
// The application roster is DERIVED from the packages' own `dsh.appRow`
// declarations (AR2 ⑤): a hardcoded list would exclude a newly wired fifth
// application from every comparison below. A package without a `dsh.appRow`
// is not an application by construction rather than by an exclusion list.
const appPackages = appPackagesOf(ROOT)
const appIds = appPackages.map((app) => app.id)
const allRows = patchRowsOf(read(PATCH))
const patchRows = machineryRowsOf(allRows, appIds)
const declaredRows = (descriptor?.services ?? []).map((row) => ({ id: row.id, name: row.package }))
for (const problem of machineryRowProblems({ machineryRows: patchRows, declaredRows })) problems.push(problem)

// 3. application rows vs each package's dsh.appRow, both directions.
const appRows = appPackages.map((app) => ({ id: app.id, name: app.name }))
const declaredApps = (descriptor?.applications ?? []).map((row) => ({ id: row.id, name: row.package }))
for (const problem of appRosterProblems({ appRows, declaredApps, retired: descriptor?.retired?.applications ?? [] })) problems.push(problem)

// 4. the client-plugin rows ↔ the declared client packages, both directions
// (AR2 ①). A row naming an undeclared package and a declared package that no
// row mounts are both drift; the disk check below only proves the declared
// side exists.
for (const problem of clientRowProblems({ clientRows: clientRowsOf(allRows), clientPackages: descriptor?.client?.packages ?? [] })) {
  problems.push(problem)
}

// 4b. the declared client packages ↔ the packages declaring a `dsh.client`
// face, both directions (arch-review 2026-09-20, client-roster-not-derived): the
// declaration was hand-written and checked one way only, so a client package
// nobody declared stayed invisible.
for (const problem of clientRosterProblems({ declared: descriptor?.client?.packages ?? [], derived: clientFacePackages(), retired: descriptor?.retired?.clientPackages ?? [] })) {
  problems.push(problem)
}

// 4b′. the declared client packages exist on disk.
const byName = packageDirsByName(ROOT)
for (const pkg of descriptor?.client?.packages ?? []) {
  const dir = byName.get(pkg)
  if (dir === undefined) {
    problems.push(`declared client package ${pkg} has no package in the workspace`)
    continue
  }
  const manifest = JSON.parse(read(join(dir, 'package.json')))
  if (manifest.dsh?.client === undefined) problems.push(`declared client package ${pkg} declares no dsh.client half`)
}

// 4c. inlined static libraries exist (they carry no dsh.client half by design).
for (const pkg of descriptor?.client?.inlined ?? []) {
  if (!byName.has(pkg)) problems.push(`declared inlined client library ${pkg} has no package in the workspace`)
}

// 5. execution compositions exist.
for (const composition of descriptor?.execution?.compositions ?? []) {
  if (!existsSync(join(ROOT, composition.path))) problems.push(`declared composition ${composition.path} does not exist`)
}

// 5b. workspace files: every declared cwd-relative business file must really be
// bound somewhere in the composition — the workbook document by its
// bundle-patch row config, an application's own document by that package's
// `dsh.appRow.config`.
// Both directions since 2026-09-22: a `${process.cwd()}/…` binding nobody
// declares is drift, exactly as in 5c's home half. (The descriptor is the single
// verifiable declaration of where a workspace's data lives; an unchecked path
// claim would defeat that.)
problems.push(...workspaceFileProblems({ workspaceFiles: descriptor?.workspaceFiles ?? [], sources: [read(PATCH), ...appRowConfigValues()] }))

// 5c. home files: the harness-home half of the same declaration, both directions
// — every declared home file must be bound by a composition (exact literal text;
// the `!!js` expression is never evaluated here), and every `dshHomePath(...)` a
// composition binds must be declared. Until 2026-09-20 only the workspace half
// had a gate (arch-review 2026-09-16 ⑧, landed 2026-09-20).
problems.push(...homeFileProblems({ homeFiles: descriptor?.homeFiles ?? [], sources: [read(PATCH), ...appRowConfigValues()] }))

// 6. the profile shape the descriptor claims.
const generated = execFileSync(process.execPath, [join(ROOT, 'scripts/setup.mjs'), '--dry-run'], { cwd: ROOT, encoding: 'utf8' })
const manifestHeader = '# --- package.json ---\n'
const patchHeader = '# --- cordis.patch.yml ---\n'
const manifestStart = generated.indexOf(manifestHeader)
const patchStart = generated.indexOf(patchHeader)
const manifestEnd = generated.indexOf('\n# --- ', manifestStart + manifestHeader.length)
const profileManifest = JSON.parse(generated.slice(manifestStart + manifestHeader.length, manifestEnd === -1 ? patchStart : manifestEnd).trim())
const bundles = profileManifest.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.includes(descriptor?.execution?.profile?.bundleLayer)) {
  problems.push(`the profile manifest does not declare ${JSON.stringify(descriptor?.execution?.profile?.bundleLayer)} among dsh.profile.bundles`)
}
if (generated.slice(patchStart + patchHeader.length).includes('- insert:')) {
  problems.push('the profile patch is not the empty user layer the descriptor claims')
}

// 7. T4: the generated profile against the declared line's own initProfile
// contract. The official sample comes from the INSTALLED platform package (the
// declared version), never from a checkout: a newer checkout is not the pin.
// A missing or version-mismatched official package is a CONFIGURATION ERROR on
// this line (fail closed) — only an optional checkout's absence may degrade to
// UNVERIFIED, and this check does not need a checkout at all.
let profileContract = 'UNVERIFIED (not executed)'
const declaredLine = descriptor?.platform?.declaredLine
const appBoot = officialAppBoot({ root: ROOT, declaredLine })
const bundleLists = officialBundleLists({ root: ROOT, declaredLine })
if (appBoot.status === 'missing') {
  problems.push('T4: the declared line\'s @deepseek-ai/dsh-app-boot is not installed — the official initProfile sample cannot be produced; run: (repo) pnpm install')
} else if (appBoot.status === 'mismatch') {
  problems.push(`T4: installed @deepseek-ai/dsh-app-boot ${appBoot.version} does not match the declared line ${declaredLine} — align the platform pins`)
} else if (bundleLists.status === 'missing') {
  problems.push('T4: the declared line\'s @deepseek-ai/dsh-official-bundles is not installed — the official bundle lists cannot be read; run: (repo) pnpm install')
} else if (bundleLists.status === 'mismatch') {
  problems.push(`T4: installed @deepseek-ai/dsh-official-bundles ${bundleLists.version} does not match the declared line ${declaredLine} — align the platform pins`)
} else {
  const official = mkdtempSync(join(tmpdir(), 'dsh-profile-official-'))
  try {
    // The official contract, executed for real: three files, never touching
    // an existing one (the temp dir is empty, so it writes them all). The
    // writer and the bundle list come from two packages on the declared line.
    const { initProfile } = await import('@deepseek-ai/dsh-app-boot')
    const { DEFAULT_PROFILE_BUNDLES } = await import('@deepseek-ai/dsh-official-bundles')
    initProfile(official, DEFAULT_PROFILE_BUNDLES)
    // Ours, from the same writer setup uses: the dry run reports the scratch
    // directory it wrote the profile files into.
    const dryRun = execFileSync(process.execPath, [join(ROOT, 'scripts/setup.mjs'), '--dry-run'], { cwd: ROOT, encoding: 'utf8' })
    const scratch = /scratch (\S+) for inspection/u.exec(dryRun)?.[1]
    if (scratch === undefined || !existsSync(join(scratch, 'package.json'))) {
      problems.push('T4: the setup dry run did not report a scratch profile directory to compare')
    } else {
      const failures = compareProfileShape({ official, ours: scratch, parseYaml })
      for (const failure of failures) problems.push(`T4: ${failure}`)
      if (failures.length === 0) {
        profileContract = `PASS (@deepseek-ai/dsh-app-boot ${appBoot.version}, @deepseek-ai/dsh-official-bundles ${bundleLists.version}: files, manifest field types, pnpm settings and patch shape match the official sample)`
      } else {
        profileContract = `FAIL (${failures.length} difference(s) against @deepseek-ai/dsh-app-boot ${appBoot.version} + @deepseek-ai/dsh-official-bundles ${bundleLists.version})`
      }
    }
  } catch (error) {
    problems.push(`T4: comparing against the official initProfile failed to run: ${String(error.message ?? error)}`)
  } finally {
    rmSync(official, { recursive: true, force: true })
  }
  }

if (problems.length > 0) {
  console.error('verify-deployment-descriptor: the deployment descriptor and the real composition disagree:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-deployment-descriptor: T4 profile contract ${profileContract}`)
console.log(`verify-deployment-descriptor: OK — ${declaredRows.length} service rows, ${declaredApps.length} applications, ${(descriptor?.client?.packages ?? []).length} client packages, ${(descriptor?.execution?.compositions ?? []).length} compositions all agree (level: ${descriptor.deployment.level})`)
