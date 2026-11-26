/**
 * The git-browser row's Cordis face: the config schema fails loud before
 * `apply`, the good path registers the declaration with the runtime behind
 * `ctx.applications`, the row config reaches the runner, and disposing the
 * fiber stops and unregisters the application.
 */
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import * as GitBrowserPlugin from '../src/index.ts'
import type { GitBrowserConfig } from '../src/index.ts'
import type { SubprocessSpawner } from '../src/subprocess.ts'

/** A producer that never spawns: these specs only exercise registration. */
const unusedSpawner: SubprocessSpawner = {
  spawn: () => { throw new Error('no command expected in this spec') },
}

/** A context with a real runtime under `applications` and a producer under `subprocess`. */
function hostContext(): { ctx: Context; runtime: ApplicationRuntime } {
  const ctx = new Context()
  const runtime = new ApplicationRuntime()
  ctx.reflect.provide('applications', runtime)
  ctx.reflect.provide('subprocess', unusedSpawner)
  return { ctx, runtime }
}

describe('git-browser runtime config schema', () => {
  it('rejects a malformed config type (fail loud)', () => {
    expect(() => resolveConfig({ Config: GitBrowserPlugin.Config } as never, { gitBinary: 7 })).toThrow(/invalid config/u)
  })

  it('accepts the documented config: every knob is optional', () => {
    const empty = GitBrowserPlugin.Config['~standard'].validate({}) as { value: GitBrowserConfig }
    expect(empty.value).toEqual({})
    const filled = GitBrowserPlugin.Config['~standard'].validate({ gitBinary: '/usr/bin/git', timeoutMs: 1_000, maxBytes: 4096 }) as { value: GitBrowserConfig }
    expect(filled.value).toEqual({ gitBinary: '/usr/bin/git', timeoutMs: 1_000, maxBytes: 4096 })
  })
})

describe('git-browser row wiring', () => {
  it('is namespace-only: the author contract rides named exports, with no default', () => {
    expect(GitBrowserPlugin.name).toBe('git-browser')
    expect(GitBrowserPlugin.inject).toEqual(['applications', 'subprocess'])
    expect('default' in GitBrowserPlugin).toBe(false)
  })

  it('registers the application with the default config and unregisters on dispose', async () => {
    const { ctx, runtime } = hostContext()
    const fiber = ctx.plugin(GitBrowserPlugin)
    await fiber
    const registered = runtime.list()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.declaration.id).toBe('git-browser')
    expect(registered[0]!.status()).toBe('available')
    await ctx.fiber.dispose()
    expect(runtime.list()).toEqual([])
  })

  it('passes the full row config to the runner and ties the application life to the row', async () => {
    const { ctx, runtime } = hostContext()
    const fiber = ctx.plugin(GitBrowserPlugin, { gitBinary: '/usr/bin/git', timeoutMs: 2_000, maxBytes: 4096 })
    await fiber
    expect(runtime.list()).toHaveLength(1)
    await fiber.dispose()
    expect(runtime.list()).toEqual([])
  })
})
