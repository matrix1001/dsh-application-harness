#!/usr/bin/env node
/**
 * The single daily development loop.
 *
 * One command builds the workspace, starts a host-HMR overlay, launches dsh
 * web, and rebuilds on source changes. The platform's client-hmr reloads
 * browser bundles; the host HMR service reconciles rebuilt host plugins. There
 * is no custom reload button or dev route.
 *
 * The rebuild is one debounced, sequential pipeline. Host tsc, typert, client
 * tsc, host tsdown and client tsdown share the same `lib/` tree, so running
 * their watch processes concurrently races on chrome/client artifacts; a
 * sequential pipeline is slower per save but always produces a consistent
 * generation.
 *
 * The profile is bootstrapped only when missing. An existing profile is never
 * rewritten; a stale preflight is reported for the developer to fix with
 * `pnpm run setup`.
 *
 * Usage:
 *   pnpm dev
 *   pnpm dev --watch-only
 * @module scripts/dev
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFILE_DEFAULT, resolveProfileDir } from './deployment-packages.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEV = join(ROOT, 'tmp', 'dev')
const OVERLAY = join(DEV, 'hmr.patch.yml')
const PROFILE = PROFILE_DEFAULT
const watchOnly = process.argv.includes('--watch-only')
const useHmr = process.argv.includes('--hmr')
const forwarded = process.argv.slice(2).filter((arg) => arg !== '--watch-only' && arg !== '--hmr')
const bin = (name) => join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const PLATFORM_TYPES = join(ROOT, 'scripts', 'platform-types.mjs')

let stopping = false
let server
let buildTimer
let buildRunning = false
let buildQueued = false
let pending = emptyJob()

/** A build request; client-only edits stay out of the host reload path. */
function emptyJob() {
  return { host: false, clients: new Set(), fullClient: false, typert: false }
}

/** Run one build step synchronously. */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`)
}

/** Run the compiler with the checkout type paths around it. */
function runTsc(args) {
  run(process.execPath, [PLATFORM_TYPES, '--run', process.execPath, TSC, ...args])
}

/** Whether the daily profile exists. */
function profilePresent() {
  return existsSync(join(resolveProfileDir({ profile: PROFILE }), 'package.json'))
}

/** The HMR overlay: one row overriding the base hmr config, with absolute base. */
function writeOverlay() {
  mkdirSync(DEV, { recursive: true })
  const ignored = [
    '**/node_modules/**',
    '**/.*',
    '**/src/**',
    '**/tests/**',
    '**/*.map',
    '**/*.d.ts',
    '**/lib/client.js',
    '**/client/**',
    '**/tsconfig*.json',
  ]
  const lines = [
    // The platform client-hmr is mounted by the web bundle, but a linked
    // app view depends on the applications shell; replacing the view cascades
    // through that dependency and can reset the open panel/connection. Keep
    // client reloads explicit (browser refresh) and leave host HMR enabled.
    '- id: client-hmr',
    "  name: '@deepseek-ai/dsh-client-hmr'",
    '  disabled: true',
    '- id: hmr',
    "  name: '@deepseek-ai/dsh-hmr'",
    '  config:',
    `    base: ${JSON.stringify(ROOT)}`,
    '    root:',
    '      - packages/application',
    '      - packages/examples',
    '      - packages/bundle',
    '    ignored:',
    ...ignored.map((pattern) => `      - ${JSON.stringify(pattern)}`),
    '    debounce: 300',
    '',
  ]
  writeFileSync(OVERLAY, lines.join('\n'))
}

/** Build the queued scope; no host work for a client-only edit. */
function buildGeneration() {
  if (stopping) return false
  if (buildRunning) {
    buildQueued = true
    return true
  }
  const job = pending
  pending = emptyJob()
  if (!job.host && job.clients.size === 0 && !job.fullClient) return true
  buildRunning = true
  let ok = true
  try {
    if (job.host) {
      process.stdout.write('dev: building host…\n')
      runTsc(['-b', 'tsconfig.host.json'])
      if (job.typert) run(process.execPath, [join(ROOT, 'scripts', 'generate-typert.mjs')])
      runTsc(['-b', '--force', 'tsconfig.client.json'])
      run(bin('tsdown'), [])
      if (job.fullClient || job.typert) run(bin('tsdown'), [], { ...process.env, DSH_BUILD_FACE: 'client' })
    } else {
      process.stdout.write('dev: building client…\n')
      runTsc(['-b', '--force', 'tsconfig.client.json'])
      if (job.fullClient) {
        run(bin('tsdown'), [], { ...process.env, DSH_BUILD_FACE: 'client' })
      } else {
        for (const dir of job.clients) run(bin('tsdown'), [], { cwd: join(ROOT, 'packages', 'client', dir), env: { ...process.env, DSH_BUILD_FACE: 'client' } })
      }
    }
  } catch (error) {
    process.stderr.write(`dev: build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    ok = false
  } finally {
    buildRunning = false
  }
  if (buildQueued && !stopping && ok) {
    buildQueued = false
    buildGeneration()
  }
  return ok
}

/** Initial generation: every host face and every client bundle. */
function buildAll() {
  pending.host = true
  pending.fullClient = true
  pending.typert = true
  return buildGeneration()
}

/** Debounce a source edit; repeated saves during a build collapse to one more generation. */
function scheduleBuild(path, typert) {
  if (stopping) return
  const match = /^packages\/(client|examples|application|bundle|typert)\/([^/]+)\/src\//.exec(path)
  if (match === null) {
    pending.host = true
    pending.typert = pending.typert || typert
    return
  }
  const [, area, dir] = match
  if (area === 'client') {
    pending.clients.add(dir)
    if (dir === 'chrome') pending.fullClient = true
  } else {
    pending.host = true
    if (typert) {
      pending.typert = true
      pending.fullClient = true
    }
  }
  if (buildTimer !== undefined) clearTimeout(buildTimer)
  buildTimer = setTimeout(() => {
    buildTimer = undefined
    buildGeneration()
  }, 300)
}

/** Watch source files only; lib writes would otherwise rebuild forever. */
function watchSources() {
  const packages = join(ROOT, 'packages')
  try {
    watch(packages, { recursive: true }, (_event, filename) => {
      if (typeof filename !== 'string' || stopping) return
      const path = `packages/${filename.replaceAll('\\', '/')}`
      if (!path.includes('/src/') || path.includes('/lib/') || path.includes('/tests/') || path.includes('/node_modules/')) return
      if (!/\.(?:ts|tsx|css)$/.test(path) || path.endsWith('.d.ts')) return
      const typert = path.includes('/host-bridge/src/') || path.includes('/typert/protocol/src/')
      scheduleBuild(path, typert)
      process.stdout.write(`dev: change ${path}${typert ? ' (typert)' : ''}\n`)
    }).on('error', (error) => process.stderr.write(`dev: source watcher: ${String(error)}\n`))
  } catch (error) {
    process.stderr.write(`dev: source watcher unavailable: ${String(error)}\n`)
  }
}

/** Stop the server once. */
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  if (buildTimer !== undefined) clearTimeout(buildTimer)
  if (server !== undefined && server.exitCode === null && server.signalCode === null) {
    try {
      if (process.platform !== 'win32' && server.pid !== undefined) process.kill(-server.pid, 'SIGTERM')
      else server.kill('SIGTERM')
    } catch {
      // The process may already be gone.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    try {
      if (process.platform !== 'win32' && server.pid !== undefined) process.kill(-server.pid, 'SIGKILL')
      else server.kill('SIGKILL')
    } catch {
      // The process may already be gone.
    }
  }
  process.exitCode = code
}

/** Start dsh web and stop the loop if it exits unexpectedly. */
function startServer(hmr) {
  const args = [join(ROOT, 'scripts', 'start.mjs'), '--profile', PROFILE, ...(hmr ? ['--patch', OVERLAY] : []), ...forwarded]
  server = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
  server.once('error', (error) => {
    process.stderr.write(`dev: dsh web: ${String(error)}\n`)
    void stop(1)
  })
  server.once('exit', (code, signal) => {
    if (stopping) return
    process.stderr.write(`dev: dsh web exited (${signal ?? code}); stopping\n`)
    void stop(code === 0 ? 0 : 1)
  })
}

function main() {
  if (!watchOnly && !profilePresent()) {
    process.stdout.write(`dev: profile ${PROFILE} is missing — running setup…\n`)
    run(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--profile', PROFILE])
  }

  run(process.execPath, [PLATFORM_TYPES, '--prepare'])
  if (!buildAll()) {
    void stop(1)
    return
  }
  if (watchOnly) {
    process.stdout.write('dev: watch-only; dsh web is not started\n')
  } else {
    if (useHmr) {
      writeOverlay()
      process.stdout.write(`dev: experimental HMR overlay ${OVERLAY}\n`)
    } else {
      process.stdout.write('dev: HMR off; host changes require restarting dev (pass --hmr to experiment)\n')
    }
    startServer(useHmr)
  }
  watchSources()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0) })
  process.stdout.write(`dev: watching; ${watchOnly ? 'server is not managed' : 'Ctrl-C stops server'}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`dev: ${error instanceof Error ? error.message : String(error)}\n`)
  void stop(1)
}
