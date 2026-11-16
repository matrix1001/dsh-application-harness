import { describe, expect, it } from 'vitest'
import { AppError, ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration } from '../src/index.ts'

function objectApp(over: Partial<AppDeclaration> = {}, execute?: (id: string) => unknown): AppDeclaration {
  return {
    id: 'objects', name: 'Objects', description: 'object resolver', version: '1.0.0',
    objectTypes: { task: { description: 'a task', resolveOperation: 'resolve' } },
    ops: {
      resolve: {
        description: 'resolve a task',
        params: { id: { type: 'string', required: true } },
        result: { type: 'json' },
        effect: 'read',
        exposure: { ai: 'open' },
        execute: (args) => execute === undefined
          ? { ref: { appId: 'objects', type: 'task', id: (args as { id: string }).id }, title: 'Task 1', summary: 'open' }
          : execute((args as { id: string }).id) as never,
      },
    },
    ...over,
  }
}

describe('object resolution', () => {
  it('resolves through the declared read operation with the caller identity', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(objectApp())
    const ref = { appId: 'objects', type: 'task', id: '1' }
    expect(await runtime.resolveObject({ kind: 'human' }, ref)).toEqual({ ref, title: 'Task 1', summary: 'open' })
    expect(await runtime.resolveObject({ kind: 'ai', sessionId: 's' }, ref)).toEqual({ ref, title: 'Task 1', summary: 'open' })
  })

  it('refuses malformed, unknown or failed references', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(objectApp())
    await expect(runtime.resolveObject({ kind: 'human' }, { appId: '', type: 'task', id: '1' })).rejects.toThrow(/non-empty/u)
    await expect(runtime.resolveObject({ kind: 'human' }, { appId: 'missing', type: 'task', id: '1' })).rejects.toThrow(/no application/u)
    await expect(runtime.resolveObject({ kind: 'human' }, { appId: 'objects', type: 'missing', id: '1' })).rejects.toThrow(/does not declare the object type/u)
    const failing = new ApplicationRuntime()
    await failing.register(objectApp({}, () => { throw new AppError('missing', 'task not found') }))
    await expect(failing.resolveObject({ kind: 'human' }, { appId: 'objects', type: 'task', id: '1' })).rejects.toThrow(/task not found/u)
  })

  it('refuses a resolver result that does not match the requested ref or display shape', async () => {
    const bad = async (value: unknown): Promise<void> => {
      const runtime = new ApplicationRuntime()
      await runtime.register(objectApp({}, () => value))
      await expect(runtime.resolveObject({ kind: 'human' }, { appId: 'objects', type: 'task', id: '1' }))
        .rejects.toThrow(/(resolution|different object reference|display title|summary must)/u)
    }
    await bad(null)
    await bad([])
    await bad({ ref: { appId: 'objects', type: 'task', id: '2' }, title: 'Task' })
    await bad({ ref: { appId: 'other', type: 'task', id: '1' }, title: 'Task' })
    await bad({ ref: { appId: 'objects', type: 'other', id: '1' }, title: 'Task' })
    await bad({ ref: { appId: 'objects', type: 'task', id: '1' }, title: ' ' })
    await bad({ ref: { appId: 'objects', type: 'task', id: '1' }, title: 'Task', summary: 1 })
    await bad({ ref: null, title: 'Task' })
  })

  it('omits an absent summary and validates the object-type declaration', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(objectApp({}, id => ({ ref: { appId: 'objects', type: 'task', id }, title: 'Task' })))
    expect(await runtime.resolveObject({ kind: 'human' }, { appId: 'objects', type: 'task', id: '1' }))
      .toEqual({ ref: { appId: 'objects', type: 'task', id: '1' }, title: 'Task' })
    expect(() => new ApplicationRuntime().mount(objectApp({ objectTypes: { 'Bad Type': { resolveOperation: 'resolve' } } })))
      .toThrow(/must match/u)
    expect(() => new ApplicationRuntime().mount(objectApp({ objectTypes: { task: { resolveOperation: 'missing' } } })))
      .toThrow(/undeclared resolver/u)
    expect(() => new ApplicationRuntime().mount(objectApp({}, undefined)))
    // A write operation cannot resolve a reference.
    const write = objectApp()
    const runtime2 = new ApplicationRuntime()
    expect(() => runtime2.mount({ ...write, ops: { resolve: { ...write.ops.resolve!, effect: 'write' } }, objectTypes: { task: { resolveOperation: 'resolve' } } }))
      .toThrow(/must use a read operation/u)
    expect(() => new ApplicationRuntime().mount({ ...write, ops: { resolve: { ...write.ops.resolve!, effect: undefined as unknown as 'read' } }, objectTypes: { task: { resolveOperation: 'resolve' } } }))
      .toThrow(/must use a read operation/u)
  })
})
