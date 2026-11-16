#!/usr/bin/env node
/**
 * Local acceptance for the plugin tarball.
 *
 * Builds the workspace on the npm line, packs one self-contained bundle
 * tarball, creates an isolated web profile, installs that tarball with
 * `dsh plugin add`, and checks the nested package closure and composed rows.
 * No registry, GitHub, or npm account is involved.
 *
 * The build is switched to the npm line first and restored to the normal
 * (checkout) line afterwards, so the command is safe to run in a daily
 * workspace — it just takes two builds. Pass `--keep` to retain the profile
 * and tarball for inspection; they live under `tmp/plugin-e2e`.
 *
 * Usage:
 *   node scripts/test-plugin-local.mjs
 *   node scripts/test-plugin-local.mjs --keep --no-restore
 * @module scripts/test-plugin-local
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, 'tmp', 'plugin-e2e')
const TARBALL_DIR = join(WORK, 'tarball')
const HOME = join(WORK, 'home')
const STORE = join(WORK, 'store')
const USER_HOME = join(WORK, 'userhome')
const PROFILE = 'plugin-e2e'
const DSH_BIN = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BUILD_RELEASE = join(ROOT, 'scripts', 'build-release.mjs')
const BUILD_TARBALL = join(ROOT, 'scripts', 'build-plugin-tarball.mjs')
const BUNDLE = '@matrix1001/dsh-application-harness'

const keep = process.argv.includes('--keep')
const restore = !process.argv.includes('--no-restore')
const workspace = `/tmp/dsh-plugin-e2e-${process.pid}`

/** Run a child and fail on a non-zero exit. */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`)
}

/** Read a JSON file. */
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The bundle's current version. */
function bundleVersion() {
  return json(join(ROOT, 'packages', 'bundle', 'app-harness', 'package.json')).version
}

async function main() {
  if (!existsSync(DSH_BIN)) throw new Error(`test-plugin: ${DSH_BIN} is missing — run node scripts/deps.mjs first`)
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(USER_HOME, { recursive: true })
  mkdirSync(TARBALL_DIR, { recursive: true })
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })

  const env = {
    ...process.env,
    HOME: USER_HOME,
    DSH_HOME: HOME,
    DSH_WORKSPACE: workspace,
  }
  // Profile initialization runs pnpm without a store flag; point only that
  // child at the isolated store. `dsh plugin add` gets `--store-dir` below.
  const initEnv = { ...env, npm_config_store_dir: STORE }

  let failed
  try {
    process.stdout.write('test-plugin: building on the npm release line…\n')
    run(process.execPath, [BUILD_RELEASE], env)

    process.stdout.write('test-plugin: packing self-contained bundle tarball…\n')
    run(process.execPath, [BUILD_TARBALL, '--out', TARBALL_DIR], env)
    const version = bundleVersion()
    const tarball = join(TARBALL_DIR, `matrix1001-dsh-application-harness-${version}.tgz`)
    if (!existsSync(tarball)) throw new Error(`test-plugin: tarball was not created: ${tarball}`)

    process.stdout.write('test-plugin: creating isolated web profile…\n')
    run(process.execPath, [DSH_BIN, '--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], initEnv)
    const profileDir = join(HOME, 'profiles', PROFILE)

    process.stdout.write(`test-plugin: installing ${tarball}…\n`)
    run(process.execPath, [DSH_BIN, 'plugin', '--profile', PROFILE, 'add', tarball, '--store-dir', STORE], env)

    const profile = json(join(profileDir, 'package.json'))
    if (!profile.dsh?.profile?.bundles?.includes(BUNDLE)) throw new Error('test-plugin: the bundle was not added to dsh.profile.bundles')
    if (!String(profile.dependencies?.[BUNDLE] ?? '').includes('matrix1001-dsh-application-harness')) {
      throw new Error('test-plugin: the profile dependency does not name the installed tarball')
    }

    const bundleManifest = json(join(ROOT, 'packages', 'bundle', 'app-harness', 'package.json'))
    const expected = Object.keys(bundleManifest.dependencies).filter((name) => name.startsWith('@matrix1001/'))
    const nestedDir = join(profileDir, 'node_modules', BUNDLE, 'node_modules', '@matrix1001')
    if (!existsSync(nestedDir)) throw new Error(`test-plugin: nested own packages directory is missing: ${nestedDir}`)
    const nested = readdirSync(nestedDir).sort()
    const missing = expected.filter((name) => !existsSync(join(nestedDir, name.slice('@matrix1001/'.length), 'package.json')))
    if (missing.length > 0) throw new Error(`test-plugin: installed bundle is missing row packages: ${missing.join(', ')}`)
    if (nested.length !== expected.length) throw new Error(`test-plugin: expected ${expected.length} nested own packages, found ${nested.length}`)
    if (!existsSync(join(profileDir, 'node_modules', BUNDLE, 'locale', 'en.json'))) {
      throw new Error('test-plugin: installed bundle is missing locale/en.json')
    }

    const dump = spawnSync(process.execPath, [DSH_BIN, '--profile', PROFILE, '--dump-config'], { cwd: ROOT, encoding: 'utf8', env })
    if (dump.status !== 0) throw new Error(`test-plugin: --dump-config exited ${String(dump.status)}: ${dump.stderr}`)
    for (const row of ['@matrix1001/dsh-application-harness-client-applications', '@matrix1001/dsh-application-harness-notes', '@matrix1001/dsh-application-harness-notes-view', '@deepseek-ai/dsh-client-ui-sidebar']) {
      if (!dump.stdout.includes(row)) throw new Error(`test-plugin: composed profile is missing ${row}`)
    }

    process.stdout.write(`test-plugin: PASS — ${nested.length} nested own package(s), bundle layer present, platform sidebar retained\n`)
    if (keep) {
      process.stdout.write(`test-plugin: kept tarball=${tarball}\n`)
      process.stdout.write(`test-plugin: kept home=${HOME}\n`)
      process.stdout.write(`test-plugin: start with DSH_HOME=${HOME} DSH_WORKSPACE=${workspace} node ${DSH_BIN} --profile ${PROFILE} --no-open --port 3100\n`)
    }
  } catch (error) {
    failed = error
    process.stderr.write(`test-plugin: FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    if (restore) {
      process.stdout.write('test-plugin: restoring the checkout-line build…\n')
      const result = spawnSync('pnpm', ['run', 'build:dev'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
      if (result.status !== 0) process.stderr.write('test-plugin: warning: the checkout-line build restore failed; run `pnpm run build:dev`\n')
    }
    if (!keep) {
      rmSync(WORK, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }
  if (failed !== undefined) process.exit(1)
}

await main()
