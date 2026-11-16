/**
 * The tool-bridge's row config is a runtime Standard Schema (no tunables):
 * a scalar row config is a bad config and fails the fiber, and the row mounts
 * (and disposes) cleanly with an empty object config over the real runtime.
 */
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import { apply as applyRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { describe, expect, it } from 'vitest'
import * as ToolBridge from '../src/index.ts'
import { StubTools } from './harness.ts'

describe('tool-bridge runtime config schema', () => {
  it('rejects a scalar config (fail loud)', () => {
    expect(() => resolveConfig({ Config: ToolBridge.Config } as never, 'nope')).toThrow(/invalid config/)
  })

  it('refuses to mount without the application runtime', () => {
    expect(() => ToolBridge.apply(new Context(), {})).toThrow(/application runtime/u)
  })

  it('the mount path with an empty object config starts and disposes cleanly', async () => {
    const ctx = new Context()
    ctx.reflect.provide('tools', new StubTools() as never)
    applyRuntime(ctx, {})
    const fiber = ctx.plugin(ToolBridge, {})
    await fiber
    await ctx.fiber.dispose()
  })
})
