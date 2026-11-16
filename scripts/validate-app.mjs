#!/usr/bin/env node
/**
 * Start one isolated validation instance for an application candidate.
 *
 * The instance owns a fresh `HOME`, `DSH_HOME`, `application-harness` profile, workspace
 * and port under `tmp/validation-<app>/`; it never reads or writes the daily
 * world. The platform CLI is the checkout's built binary, so the candidate is
 * whatever this worktree has just built. Nothing is applied to the daily
 * deployment: promotion is a separate, explicit deployment action.
 *
 * Usage:
 *   node scripts/validate-app.mjs --app notes [--port 0] [--checkout <dir>]
 *   node scripts/validate-app.mjs --app notes --keep   # leave the temp world
 *
 * The URL is printed once dsh reports it; the process keeps running until
 * Ctrl-C. `--port 0` lets the OS choose a free port.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshBin } from './platform-checkout.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROFILE = 'application-harness'

/**
 * Parse the validation command line.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ app: string, port: number, checkout?: string, keep: boolean, root?: string, help: boolean }} options.
 */
export function parseValidateArgs(argv) {
  const options = { app: '', port: 0, keep: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--keep') { options.keep = true; continue }
    if (arg === '--app' || arg === '--port' || arg === '--checkout' || arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      index += 1
      if (arg === '--app') options.app = value
      else if (arg === '--port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be an integer between 0 and 65535')
        options.port = port
      } else if (arg === '--checkout') options.checkout = resolve(value)
      else options.root = resolve(value)
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  if (!options.help && !/^[a-z][a-z0-9-]*$/u.test(options.app)) throw new Error('--app must be a stable application id (lower-case letters, digits, dash)')
  return options
}

/** The URL dsh prints once the web app is listening. */
export function webUrlOf(line) {
  const match = /dsh web:\s+(https?:\/\/\S+)/u.exec(line)
  return match?.[1]
}

/** The per-app isolated world directory. */
export function validationPaths(root = join(REPOSITORY_ROOT, 'tmp'), app) {
  const base = join(root, `validation-${app}`)
  return { base, home: join(base, 'home'), userHome: join(base, 'user-home'), workspace: join(base, 'workspace') }
}

function main() {
  let options
  try { options = parseValidateArgs(process.argv.slice(2)) } catch (error) {
    console.error(`validate-app: ${String(error.message ?? error)}`)
    process.exit(2)
  }
  if (options.help) {
    console.log('usage: node scripts/validate-app.mjs --app <id> [--port <n>] [--checkout <dir>] [--keep] [--root <dir>]')
    return
  }
  const paths = validationPaths(options.root, options.app)
  // `--app` must name an application this checkout actually deploys and has
  // built; otherwise the command boots a full profile and prints a URL that
  // proves nothing about the named candidate.
  const deployment = readFileSync(join(REPOSITORY_ROOT, 'packages/bundle/app-harness/deployment.yml'), 'utf8')
  if (!new RegExp(`^\\s*- id: ${options.app}$`, 'mu').test(deployment)) {
    console.error(`validate-app: ${options.app} is not declared in packages/bundle/app-harness/deployment.yml`)
    process.exit(2)
  }
  const appPackage = join(REPOSITORY_ROOT, 'packages/examples', options.app)
  if (!existsSync(join(appPackage, 'package.json')) || !existsSync(join(appPackage, 'lib/index.js'))) {
    console.error(`validate-app: ${options.app} has no built example package at ${appPackage}`)
    process.exit(2)
  }
  for (const dir of [paths.home, paths.userHome, paths.workspace]) mkdirSync(dir, { recursive: true })
  const checkoutOption = options.checkout === undefined ? {} : { checkout: options.checkout }
  const resolved = resolveDshBin({ repoRoot: REPOSITORY_ROOT, ...checkoutOption })
  if (resolved.source !== 'checkout') {
    console.error(`validate-app: the platform checkout is not built (${resolved.checkout}); build it first`)
    process.exit(2)
  }
  const env = {
    ...process.env,
    HOME: paths.userHome,
    DSH_HOME: paths.home,
    DSH_WORKSPACE: paths.workspace,
  }
  console.log(`validate-app: ${options.app} -> ${paths.base}`)
  const setup = spawnSync(process.execPath, [join(REPOSITORY_ROOT, 'scripts', 'setup.mjs'), '--no-build', '--no-install', '--profile', PROFILE], {
    env, stdio: 'inherit', cwd: REPOSITORY_ROOT,
  })
  if (setup.status !== 0) process.exit(setup.status ?? 1)
  const child = spawn(process.execPath, [resolved.bin, '--profile', PROFILE, '--no-open', '--port', String(options.port)], {
    env, cwd: paths.workspace, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cleanup = () => { if (!options.keep) rmSync(paths.base, { recursive: true, force: true }) }
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    child.kill('SIGTERM')
    cleanup()
    process.exit(130)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let printed = false
  const show = (chunk, stream) => {
    const text = String(chunk)
    stream.write(text)
    if (!printed) {
      const url = webUrlOf(text)
      if (url !== undefined) {
        printed = true
        console.log(`validate-app: isolated URL ${url}`)
        console.log('validate-app: the daily deployment and data were not touched')
      }
    }
  }
  child.stdout.on('data', (chunk) => { show(chunk, process.stdout) })
  child.stderr.on('data', (chunk) => { show(chunk, process.stderr) })
  child.on('exit', (code) => {
    if (!options.keep) cleanup()
    else console.log(`validate-app: kept ${paths.base}`)
    process.exit(code ?? 0)
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
