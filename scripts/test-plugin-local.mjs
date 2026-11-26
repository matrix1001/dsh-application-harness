#!/usr/bin/env node
/**
 * Local acceptance for the plugin tarball.
 *
 * Builds the workspace, packs one self-contained bundle tarball, creates an
 * isolated web profile, installs that tarball with `dsh plugin add`, and checks
 * the nested package closure and composed rows. No registry, GitHub, or npm
 * account is involved. Pass `--keep` to retain the profile and tarball for
 * inspection; they live under `tmp/plugin-e2e`.
 *
 * Usage:
 *   node scripts/test-plugin-local.mjs
 *   node scripts/test-plugin-local.mjs --keep
 * @module scripts/test-plugin-local
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, 'tmp', 'plugin-e2e')
const TARBALL_DIR = join(WORK, 'tarball')
const HOME = join(WORK, 'home')
const STORE = join(WORK, 'store')
const USER_HOME = join(WORK, 'userhome')
const PROFILE = 'plugin-e2e'
// The installed platform line boots the isolated profile: the same binary a
// user's `dsh` is, so the acceptance cannot boot a different application set
// than the tarball. `DSH_TEST_BIN` overrides it for a rebuild from a checkout.
const DSH_BIN = process.env.DSH_TEST_BIN ?? join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BUILD_TARBALL = join(ROOT, 'scripts', 'build-plugin-tarball.mjs')
const DEPLOYMENT = join(ROOT, 'packages', 'bundle', 'app-harness', 'deployment.yml')
const BUNDLE = '@matrix1001/dsh-application-harness'

const keep = process.argv.includes('--keep')
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

/** One free loopback port for the boot smoke. */
async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('test-plugin: could not allocate a port')); return }
      const port = address.port
      server.close(() => { resolvePort(port) })
    })
  })
}

/**
 * Boot the installed profile and wait for the URL `dsh web` prints. This proves
 * bootability only: when the repo CLI is used (CI without a checkout), repo
 * workspace links can still shadow the installed package's application rows.
 * Tarball shape is verify-pack's responsibility; this smoke does not assert the
 * runtime app set.
 */
async function bootCheck(env) {
  const port = await freePort()
  const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--no-open', '--port', String(port)], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  try {
    await new Promise((resolveBoot, reject) => {
      const timer = setTimeout(() => { reject(new Error(`test-plugin: installed profile did not report a URL within 30s\n${output}`)) }, 30_000)
      const inspect = (chunk) => {
        output += String(chunk)
        if (/dsh web:\s+https?:\/\//u.test(output)) {
          clearTimeout(timer)
          resolveBoot()
        }
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`test-plugin: installed profile exited during boot (${String(signal ?? code)})\n${output}`))
      })
    })
    return `http://127.0.0.1:${String(port)}`
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return }
      child.once('exit', () => { resolveExit() })
      setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 5_000).unref()
    })
  }
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
    process.stdout.write('test-plugin: building the release tarball…\n')
    run('pnpm', ['run', 'build'], env)

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
    const deployment = parseYaml(readFileSync(DEPLOYMENT, 'utf8'))
    const expectedRows = [
      '@deepseek-ai/dsh-client-ui-sidebar',
      ...(deployment.applications ?? []).flatMap(app => [app.package, `${app.package}-view`]),
      ...(deployment.client?.packages ?? []),
    ].filter(name => typeof name === 'string')
    for (const row of expectedRows) {
      if (!dump.stdout.includes(row)) throw new Error(`test-plugin: composed profile is missing ${row}`)
    }

    process.stdout.write('test-plugin: booting the installed profile…\n')
    const url = await bootCheck(env)
    process.stdout.write(`test-plugin: boot smoke reached ${url} (composed rows asserted; browser UI is the browser lane)\n`)

    process.stdout.write(`test-plugin: PASS — ${nested.length} nested own package(s), bundle layer present, ${expectedRows.length} composed row(s), profile booted\n`)
    if (keep) {
      process.stdout.write(`test-plugin: kept tarball=${tarball}\n`)
      process.stdout.write(`test-plugin: kept home=${HOME}\n`)
      process.stdout.write(`test-plugin: start with DSH_HOME=${HOME} DSH_WORKSPACE=${workspace} node ${DSH_BIN} --profile ${PROFILE} --no-open --port 3100\n`)
    }
  } catch (error) {
    failed = error
    process.stderr.write(`test-plugin: FAIL — ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    if (!keep) {
      rmSync(WORK, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }
  if (failed !== undefined) process.exit(1)
}

await main()
