/**
 * The store's row config is a runtime Standard Schema: the loader validates
 * it before the plugin starts — a bad `dbPath` type fails the fiber.
 */
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AppStore } from '../src/index.ts'

describe('store runtime config schema', () => {
  it('rejects a bad dbPath type (fail loud)', () => {
    expect(() => resolveConfig({ Config: AppStore.Config } as never, { dbPath: {} })).toThrow(/invalid config/)
  })

  it('the mount path fails the plugin fiber on a bad config', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(AppStore, { dbPath: 7 } as never)
    await expect(fiber).rejects.toThrow(/invalid config/)
  })

  it('the mount path accepts a good config and disposes cleanly', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(AppStore, {})
    await fiber
    expect(ctx.get('applicationStore')).toBeDefined()
    await ctx.fiber.dispose()
  })
})
