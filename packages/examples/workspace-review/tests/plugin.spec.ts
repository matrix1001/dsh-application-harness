import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import * as WorkspaceReviewPlugin from '../src/index.ts'
import { tempDir } from './helpers.ts'

async function ready(runtime: ApplicationRuntime, id: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === id)?.status() === 'available') return
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error(`${id} did not become available`)
}

describe('workspace-review plugin', () => {
  it('mounts generation 2 and lists workspaces through the runtime', async () => {
    const { dir, cleanup } = await tempDir()
    const ctx = new Context()
    const runtime = new ApplicationRuntime()
    const store = new AppStore(ctx)
    ctx.reflect.provide('applications', runtime)
    await runtime.grant({ caller: { kind: 'app', appId: 'workspace-review' }, capabilities: ['capability:storage'], grantedAt: '2026-01-01T00:00:00.000Z' })
    await WorkspaceReviewPlugin.apply(ctx, { home: dir })
    await ready(runtime, 'workspace-review')
    const row = runtime.list().find(entry => entry.declaration.id === 'workspace-review')
    expect(row?.declaration).toMatchObject({
      generation: 2,
      data: { kind: 'unified', namespace: 'review', schemaVersion: 1 },
      capabilities: ['storage', 'model'],
    })
    expect(await runtime.call({ kind: 'human' }, 'workspace-review', 'listWorkspaces', {})).toMatchObject({ status: 'success', result: [] })
    const settings = await runtime.call({ kind: 'human' }, 'workspace-review', 'settings', {})
    expect(settings.status).toBe('success')
    store.close()
    await ctx.fiber.dispose()
    await cleanup()
  })
})

describe('workspace-review plugin refusal', () => {
  it('refuses to mount without the application store', async () => {
    const ctx = new Context()
    await expect(WorkspaceReviewPlugin.apply(ctx)).rejects.toThrow(/requires the application store/u)
  })
})
