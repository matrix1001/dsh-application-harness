/**
 * Coverage-focused specs for the todo application: the operations the same
 * app exposes to pages and peers that the main suite does not drive yet —
 * `resolveTask`, the delegation read/apply failure edges — plus the delegation
 * prompt truncation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { AppDelegation, DelegationPort } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import * as TodoPlugin from '../src/index.ts'

const at = '2026-01-01T00:00:00.000Z'

async function ready(runtime: ApplicationRuntime, id: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === id)?.status() === 'available') return
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error(`${id} did not become available`)
}

function host() {
  const ctx = new Context()
  const runtime = new ApplicationRuntime()
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  return { ctx, runtime, store }
}

/** One in-memory platform delegation store. */
function delegationPort() {
  const records = new Map<string, AppDelegation>()
  let serial = 0
  const port: DelegationPort = {
    create: async (appId, input) => {
      const created: AppDelegation = {
        id: `delegation-${String(++serial)}`,
        appId,
        title: input.title,
        instructions: input.instructions,
        status: 'pending',
        createdAt: at,
        updatedAt: at,
      }
      records.set(created.id, created)
      return created
    },
    list: async appId => [...records.values()].filter(record => record.appId === appId),
    read: async (appId, id) => {
      const found = records.get(id)
      return found !== undefined && found.appId === appId ? found : undefined
    },
    cancel: async (appId, id) => {
      const found = records.get(id)
      if (found === undefined || found.appId !== appId) throw new Error(`no delegation ${id}`)
      const ended: AppDelegation = { ...found, status: 'ended', outcome: 'cancelled' }
      records.set(id, ended)
      return ended
    },
  }
  return { port, records }
}

async function delegationHost() {
  const { ctx, runtime, store } = host()
  const { port, records } = delegationPort()
  runtime.useDelegationStore(port)
  await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage', 'capability:delegate'], grantedAt: at })
  await TodoPlugin.apply(ctx)
  await ready(runtime, 'todo')
  const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'todo', op, args as never)
  const create = async (title: string, extra: Record<string, unknown> = {}) => {
    const outcome = await call('createTask', { title, ...extra })
    if (outcome.status !== 'success') throw new Error('create failed')
    return (outcome.result as { id: string }).id
  }
  return { ctx, runtime, store, records, call, create }
}

describe('todo delegation prompt and read edges', () => {
  it('truncates very long notes in the prepared instructions', async () => {
    const { ctx, store, call, create } = await delegationHost()
    const notes = 'n'.repeat(4_001)
    const taskId = await create('长备注', { notes })
    const outcome = await call('createDelegation', { taskId })
    if (outcome.status !== 'success') throw new Error(JSON.stringify(outcome))
    const delegation = (outcome.result as { delegation: { instructions: string } }).delegation
    expect(delegation.instructions).toContain('…')
    expect(delegation.instructions).not.toContain(notes)
    expect(delegation.instructions).toContain('待办备注：')
    store.close()
    await ctx.fiber.dispose()
  })

  it('refuses a deleted task and reads absent, missing and dangling links', async () => {
    const { ctx, store, records, call, create } = await delegationHost()
    // No delegation yet: the read reports the absence explicitly.
    const plain = await create('plain')
    expect(await call('taskDelegation', { taskId: plain })).toMatchObject({ status: 'success', result: { delegation: null } })
    // A prepared delegation whose platform record disappeared reports `missing`.
    const prepared = await call('createDelegation', { taskId: plain })
    if (prepared.status !== 'success') throw new Error('prepare')
    const delegationId = (prepared.result as { delegation: { id: string } }).delegation.id
    records.delete(delegationId)
    expect(await call('taskDelegation', { taskId: plain })).toMatchObject({ status: 'success', result: { delegation: null, missing: true } })
    // The dangling link does not block a new delegation.
    expect(await call('createDelegation', { taskId: plain })).toMatchObject({ status: 'success' })
    // A soft-deleted todo cannot be delegated.
    const deleted = await create('deleted')
    expect(await call('deleteTask', { id: deleted })).toMatchObject({ status: 'success' })
    expect(await call('createDelegation', { taskId: deleted })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('todo applyDelegationResult edges', () => {
  it('refuses unknown, mismatched and vanished delegations', async () => {
    const { ctx, store, records, call, create } = await delegationHost()
    const taskId = await create('no delegation')
    expect(await call('applyDelegationResult', { taskId, expectedVersion: 1, delegationId: 'delegation-unknown' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.delegation-unknown' } })

    const prepared = await call('createDelegation', { taskId })
    if (prepared.status !== 'success') throw new Error('prepare')
    const delegationId = (prepared.result as { delegation: { id: string } }).delegation.id
    // The todo points at another delegation than the one the caller names.
    expect(await call('applyDelegationResult', { taskId, expectedVersion: 1, delegationId: 'delegation-other' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.delegation-unknown' } })
    records.delete(delegationId)
    expect(await call('applyDelegationResult', { taskId, expectedVersion: 1, delegationId }))
      .toMatchObject({ status: 'failed', error: { code: 'app.delegation-unknown' } })
    store.close()
    await ctx.fiber.dispose()
  })

  it('appends a failed report with its label and truncates a very long summary', async () => {
    const { ctx, store, records, call, create } = await delegationHost()
    const failedTask = await create('failed delegation')
    const failedPrepare = await call('createDelegation', { taskId: failedTask })
    if (failedPrepare.status !== 'success') throw new Error('prepare')
    const failedId = (failedPrepare.result as { delegation: { id: string } }).delegation.id
    records.set(failedId, {
      ...records.get(failedId)!,
      status: 'ended',
      outcome: 'failed',
      latestReport: { outcome: 'failed', summary: '执行失败的原因' },
    })
    const failedApply = await call('applyDelegationResult', { taskId: failedTask, expectedVersion: 1, delegationId: failedId })
    if (failedApply.status !== 'success') throw new Error(JSON.stringify(failedApply))
    expect((failedApply.result as { notes: string }).notes).toBe('\n\n[委托结果 · 失败]\n执行失败的原因')

    const longTask = await create('long delegation')
    const longPrepare = await call('createDelegation', { taskId: longTask })
    if (longPrepare.status !== 'success') throw new Error('prepare')
    const longId = (longPrepare.result as { delegation: { id: string } }).delegation.id
    const summary = 's'.repeat(8_001)
    records.set(longId, {
      ...records.get(longId)!,
      status: 'ended',
      outcome: 'completed',
      latestReport: { outcome: 'completed', summary },
    })
    const longApply = await call('applyDelegationResult', { taskId: longTask, expectedVersion: 1, delegationId: longId })
    if (longApply.status !== 'success') throw new Error(JSON.stringify(longApply))
    const notes = (longApply.result as { notes: string }).notes
    expect(notes).toBe(`\n\n[委托结果 · 完成]\n${'s'.repeat(8_000)}…`)
    store.close()
    await ctx.fiber.dispose()
  })
})
