#!/usr/bin/env node
/**
 * The browser lane's isolated instance.
 *
 * One DSH home, one profile, one workspace and one port per run, all under
 * `tmp/browser/` — the daily instance is never touched (AGENTS: 验证必须隔离
 * 家目录、profile、工作区和端口). The profile is bootstrapped from this repo's
 * deployment with `scripts/setup.mjs`, then `dsh web` is started and the token
 * URL is read from its stdout.
 *
 * `BROWSER_BASE_URL` attaches to an already-running instance instead of
 * booting one (local debugging only; CI always boots its own).
 * @module tests/browser/harness
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
const WORK = join(ROOT, 'tmp', 'browser')
const PROFILE = 'browser-e2e'
const PORT = Number(process.env.BROWSER_PORT ?? 3321)

/**
 * Start an isolated instance and wait for its URL.
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>} the URL and teardown.
 */
export async function startInstance() {
  if (process.env.BROWSER_BASE_URL !== undefined && process.env.BROWSER_BASE_URL !== '') {
    return { url: process.env.BROWSER_BASE_URL, stop: async () => {} }
  }
  const home = join(WORK, 'home')
  const workspace = join(WORK, 'workspace')
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_WORKSPACE: workspace,
    // No legacy-world discovery: an isolated run must never adopt real data.
    DSH_WORKSPACE_LEGACY: '',
    BROWSER: 'none',
  }
  const setup = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--profile', PROFILE, '--no-build'], { cwd: ROOT, stdio: 'inherit', env })
  if (setup.status !== 0) throw new Error(`browser harness: setup exited ${String(setup.status)}`)
  const bin = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`browser harness: no installed dsh at ${bin} — run node scripts/deps.mjs`)
  const child = spawn(process.execPath, [bin, '--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  const url = await new Promise((resolveUrl, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`browser harness: no dsh URL within 120s\n${buffer.slice(-4000)}`)), 120_000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u.exec(buffer)
      if (found !== null) {
        clearTimeout(timer)
        resolveUrl(found[0])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`browser harness: dsh exited ${String(code)}\n${buffer.slice(-4000)}`))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return {
    url,
    async stop() {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      await new Promise(done => child.on('exit', done))
    },
  }
}
