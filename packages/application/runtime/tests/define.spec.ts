import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, defineOperation } from '../src/index.ts'

describe('defineOperation', () => {
  it('infers execute arguments/results from the same platform DSL declaration', async () => {
    const create = defineOperation({
      description: 'create a task',
      params: { title: { type: 'string', required: true } },
      result: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', required: true } },
      },
      effect: 'write',
      execute: (args) => ({ title: args.title.toUpperCase() }),
    })

    const runtime = new ApplicationRuntime()
    await runtime.register({
      id: 'typed', name: 'Typed', description: 'typed operations', version: '1.0.0',
      ops: { create },
    })

    expect(await runtime.call({ kind: 'human' }, 'typed', 'create', { title: 'one' }))
      .toMatchObject({ status: 'success', result: { title: 'ONE' } })
    expect(await runtime.call({ kind: 'human' }, 'typed', 'create', {}))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.invalid-args' } })
  })
})
