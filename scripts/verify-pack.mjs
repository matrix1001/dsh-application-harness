/**
 * Pack verification gate: `pnpm pack` every publishable workspace package and
 * assert the tarball is installable-whole — every `exports` target resolves
 * to a file present in the tarball, every `files` entry contributes at least
 * one entry, no forbidden artifacts ship (.js.map / .tsbuildinfo / tests; a
 * `.d.ts.map` is allowed only when the manifest lists it explicitly — the rc.2
 * Typert generator requires the host package to publish its remote declaration
 * map, so the exception is the generator's requirement, not a blanket opening), and
 * the tarball stays under the size cap.
 *
 * Why: the profile installs packages from packed tarballs (release/e2e path),
 * and "the deployment copy does not follow new files" — a fresh build output
 * missing from `files`/the tarball surfaces only as ERR_MODULE_NOT_FOUND on
 * the user's boot. This gate fails at pack time instead. The negative cases
 * self-prove the checker (genui #13 pattern).
 */
import { execFileSync } from 'node:child_process'
import { npmCacheEnv } from './pnpm-store.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageDirs } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Per-tarball size cap, tunable via env; never silently relaxed. */
const MAX_BYTES = Number(process.env.DSH_PACK_MAX_BYTES ?? 10 * 1024 * 1024)

/** Artifacts that must never ship in a tarball. */
const FORBIDDEN = /(?:\.map$|\.tsbuildinfo$|\/tests?\/(?:.|\n)*|(?:^|\/)(?:coverage|\.vitest)(?:\/|$))/

/**
 * The relative paths the package's exports contract promises. Only
 * `./lib/...`-style concrete targets are asserted; conditional/star exports
 * contribute their concrete branches, and star targets (`./src/*` — the
 * dev-only source subpath, intentionally absent from the published payload)
 * are skipped.
 */
function exportTargets(manifest) {
  const targets = []
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*')) targets.push(value.slice(2))
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      if (key === 'types' || key === 'import' || key === 'require' || key === 'default' || key === 'node' || key === 'browser') {
        walk(value[key])
      } else if (key.startsWith('.')) {
        walk(value[key])
      }
    }
  }
  walk(manifest.exports ?? {})
  return targets
}

/**
 * Literal `files` entries that must contribute at least one tarball entry.
 * Glob entries (`*`/`**`) are skipped: npm's own expansion decides them, and
 * their resolvability is covered by the exports-target assertions. A literal
 * entry that matches nothing is a typo'd or renamed build output — exactly
 * the silent-miss class this gate exists to catch.
 */
function filesEntries(manifest) {
  const files = manifest.files
  if (!Array.isArray(files)) return []
  return files
    .filter(entry => !entry.startsWith('!') && !entry.includes('*'))
    .map(entry => entry.replace(/\/+$/, ''))
}

/**
 * Every RELATIVE import specifier in one shipped module.
 *
 * Only the static forms (`import … from './x.js'`, `import './x.js'`,
 * `import('./x.js')`) are read: a dynamic specifier built by concatenation is
 * out of scope for a structural check.
 * @param source - the module's text.
 * @returns the specifiers, as written.
 */
function relativeImportsOf(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/gu)].map(match => match[1])
}

/** Pack one package and run the tarball assertions. */
function checkPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const name = manifest.name
  const problems = []
  const dest = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  let tarball
  try {
    // `pnpm pack` rewrites `workspace:` to the release version and carries the
    // root LICENSE; npm pack does neither. The published form is the pnpm one
    // (the release tarball and `pnpm publish` use it).
    execFileSync('pnpm', ['pack', '--pack-destination', dest], { cwd: dir, stdio: 'pipe', env: npmCacheEnv(ROOT) })
    const packed = readdirSync(dest).filter(file => file.endsWith('.tgz'))
    if (packed.length !== 1) throw new Error(`expected exactly one tarball, got ${packed.length}`)
    tarball = join(dest, packed[0])
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(entry => entry.replace(/^package\//, ''))
    const bytes = (execFileSync('stat', ['-c', '%s', tarball], { encoding: 'utf8' }).trim())
    const size = Number(bytes)

    const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    if (JSON.stringify(packedManifest).includes('workspace:')) {
      problems.push('tarball package.json still contains a workspace: protocol')
    }
    if (manifest.license !== undefined && !listing.includes('LICENSE')) {
      problems.push('tarball omits LICENSE')
    }
    for (const target of exportTargets(manifest)) {
      if (!listing.includes(target)) problems.push(`exports target ${JSON.stringify(target)} missing from tarball`)
    }
    for (const entry of filesEntries(manifest)) {
      if (!listing.some(item => item === entry || item.startsWith(`${entry}/`))) {
        problems.push(`files entry ${JSON.stringify(entry)} contributes nothing to the tarball`)
      }
    }
    // A declaration map is shippable only when `files` names it. The rc.2
    // Typert generator requires `lib/typert.remote-client.d.ts.map` in `files`;
    // a map that merely rode in on a glob is still an accidental artifact.
    const declared = new Set(filesEntries(manifest).filter(entry => entry.endsWith('.d.ts.map')))
    for (const item of listing) {
      if (FORBIDDEN.test(item) && !declared.has(item)) problems.push(`forbidden artifact ships: ${item}`)
    }
    // Every relative import in a SHIPPED file must resolve inside the tarball.
    // A multi-entry package whose entries share a module gets a hash-named
    // chunk (rolldown hoists it), and `files` cannot enumerate a name that
    // changes every build — so the entry ships importing a file the package does
    // not ship, surfacing only as ERR_MODULE_NOT_FOUND after a profile install
    // (dsh-conformance 2026-09-23, batch 5: the workbook package's two entry
    // files both imported lib/types-<hash>.js).
    const extracted = mkdtempSync(join(tmpdir(), 'dsh-pack-x-'))
    try {
      execFileSync('tar', ['-xzf', tarball, '-C', extracted], { stdio: 'pipe' })
      for (const item of listing) {
        if (!item.endsWith('.js')) continue
        const source = readFileSync(join(extracted, 'package', item), 'utf8')
        // Unix build roots only: a drive-letter match would also hit CSS
        // escapes such as `content:"\f"` and report every stylesheet. The
        // leading boundary matters: a repo-relative id such as
        // `apps/home/view/...` contains `/home/` but is not an absolute path.
        if (/(?:^|[\s"'`(=:,])\/(?:home|Users)\/[^/\s"'`]+\//u.test(source)) {
          problems.push(`${item} contains a build-machine absolute path`)
        }
        for (const specifier of relativeImportsOf(source)) {
          const resolved = normalize(join(dirname(item), specifier))
          if (!listing.includes(resolved)) {
            problems.push(`${item} imports ${JSON.stringify(specifier)}, which the tarball does not ship (${resolved})`)
          }
        }
      }
    } finally {
      rmSync(extracted, { recursive: true, force: true })
    }
    if (size > MAX_BYTES) problems.push(`tarball ${size} bytes exceeds cap ${MAX_BYTES}`)
    if (problems.length === 0) console.log(`  ✓ ${name} (${listing.length} files, ${Math.round(size / 1024)} KiB)`)
  } catch (error) {
    problems.push(`pack failed: ${String(error?.message ?? error)}`)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
  return { name, problems }
}

/** Self-proof: synthetic broken manifests must trip the checker. */
function runNegativeSelfTests() {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-pack-selftest-'))
  const cases = [
    ['exports target missing', { exports: { '.': './lib/index.js' }, files: ['lib'] }, [], /exports target "lib\/index\.js" missing/],
    ['files entry empty', { exports: {}, files: ['ghost-dir'] }, [], /files entry "ghost-dir" contributes nothing/],
    ['forbidden map ships', { exports: {}, files: ['lib'] }, ['lib/index.js', 'lib/index.js.map'], /forbidden artifact ships: lib\/index\.js\.map/],
    ['undeclared declaration map ships', { exports: {}, files: ['lib'] }, ['lib/types.d.ts', 'lib/types.d.ts.map'], /forbidden artifact ships: lib\/types\.d\.ts\.map/],
    ['unshipped relative import', { exports: {}, files: ['lib/index.js'] }, [{ file: 'lib/index.js', content: 'import { a } from "./types-abc123.js"\nexport { a }' }], /imports "\.\/types-abc123\.js", which the tarball does not ship/],
    ['absolute build path', { exports: {}, files: ['lib/index.js'] }, [{ file: 'lib/index.js', content: 'const p = "/home/user/checkout/file"' }], /build-machine absolute path/],
  ]
  try {
    for (const [label, manifest, create, pattern] of cases) {
      const dir = join(dest, label.replace(/\s+/g, '-'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'selftest', version: '0.0.0', ...manifest }))
      for (const entry of create) {
        const file = typeof entry === 'string' ? entry : entry.file
        mkdirSync(join(dir, dirname(file)), { recursive: true })
        writeFileSync(join(dir, file), typeof entry === 'string' ? 'export {}' : entry.content)
      }
      const { problems } = checkPackage(dir)
      if (!problems.some(p => pattern.test(p))) {
        throw new Error(`negative self-test "${label}" did not trip the checker (got: ${problems.join('; ') || 'no problems'})`)
      }
    }
    // Positive guard: a repo-relative app id under apps/home/ is not a
    // build-machine path and must not be flagged (the false positive this
    // check shipped with).
    const relativeDir = join(dest, 'relative-home-app')
    mkdirSync(join(relativeDir, 'lib'), { recursive: true })
    writeFileSync(join(relativeDir, 'package.json'), JSON.stringify({ name: 'selftest-relative', version: '0.0.0', exports: {}, files: ['lib'] }))
    writeFileSync(join(relativeDir, 'lib', 'client.js'), 'const id = "apps/home/view/src/client/HomeView.module.css.mjs"\nexport { id }')
    const relativeResult = checkPackage(relativeDir)
    if (relativeResult.problems.some(problem => /build-machine absolute path/u.test(problem))) {
      throw new Error(`positive self-test: a repo-relative apps/home path was flagged as absolute (${relativeResult.problems.join('; ')})`)
    }
    console.log(`  ✓ ${cases.length} negative self-tests all trip the checker; relative apps/home path is not absolute`)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

function main() {
  console.log('verify-pack: packing workspace packages and checking tarballs')
  runNegativeSelfTests()
  const packages = packageDirs(ROOT).filter((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return manifest.private !== true
  })
  if (packages.length === 0) {
    console.error('no publishable packages found')
    process.exit(1)
  }
  let failed = 0
  for (const dir of packages) {
    const { name, problems } = checkPackage(dir)
    if (problems.length > 0) {
      console.error(`  ✘ ${name}:`)
      for (const problem of problems) console.error(`      ${problem}`)
      failed++
    }
  }
  if (failed > 0) {
    console.error(`verify-pack: ${failed} package(s) failed`)
    process.exit(1)
  }
  console.log(`verify-pack: ${packages.length} tarballs OK`)
}

main()
