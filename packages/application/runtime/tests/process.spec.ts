/**
 * The process declaration and the runtime's process entry: the capability is
 * checked before work, the command label reaches history, and the declaration
 * stays disclosure rather than a whitelist.
 */
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, AppError, assertDeclarable } from '../src/index.ts'
import type { AppDeclaration, HistoryRecord } from '../src/index.ts'

const at = '2026-01-01T00:00:00.000Z'

function processApp(over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id: 'runner',
    name: 'runner',
    description: 'runs a declared command',
    version: '1.0.0',
    generation: 2,
    data: { kind: 'none' },
    capabilities: ['process'],
    process: [{ executable: 'git', commands: ['status'], purpose: 'read a repository' }],
    ops: {
      run: {
        description: 'run one declared command',
        params: {},
        result: { type: 'json' },
        effect: 'read',
        execute: async (_args, ctx) => await ctx.process.run({ command: 'git status' }, async () => ({ ok: true })),
      },
    },
    ...over,
  }
}

describe('process declarations', () => {
  it('requires the process capability and a non-empty command list', () => {
    expect(() => assertDeclarable(processApp({ capabilities: [] }))).toThrow(/process commands but not the process capability/u)
    const { process: _process, ...withoutProcess } = processApp()
    expect(() => assertDeclarable(withoutProcess)).toThrow(/declares the process capability but no process commands/u)
    expect(() => assertDeclarable(processApp({ process: [] }))).toThrow(/1\.\.20 executables/u)
    expect(() => assertDeclarable(processApp({ process: [{ executable: 'git', commands: [], purpose: 'x' }] }))).toThrow(/1\.\.50 commands/u)
    expect(() => assertDeclarable(processApp({ process: [{ executable: 'git', commands: ['status', 'status'], purpose: 'x' }] }))).toThrow(/repeats command/u)
    expect(() => assertDeclarable(processApp({ process: [{ executable: '', commands: ['status'], purpose: 'x' }] }))).toThrow(/executable/u)
    expect(() => assertDeclarable(processApp({ process: [
      { executable: 'git', commands: ['status'], purpose: 'x' },
      { executable: 'git', commands: ['diff'], purpose: 'y' },
    ] }))).toThrow(/declares git twice/u)
    expect(() => assertDeclarable(processApp({ process: [{ executable: 'git', commands: ['status'], purpose: '' }] }))).toThrow(/purpose/u)
    expect(() => assertDeclarable(processApp({ process: [{ executable: 'git', commands: [''], purpose: 'x' }] }))).toThrow(/command must be/u)
  })
})

describe('the runtime process entry', () => {
  it('checks the grant, records the command and returns the work result', async () => {
    const history: HistoryRecord[] = []
    const runtime = new ApplicationRuntime({ history: { write: record => { history.push(record) } } })
    await runtime.register(processApp())
    expect(await runtime.call({ kind: 'human' }, 'runner', 'run', {}))
      .toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    await runtime.grant({ caller: { kind: 'app', appId: 'runner' }, capabilities: ['capability:process'], grantedAt: at })
    expect(await runtime.call({ kind: 'human' }, 'runner', 'run', {})).toMatchObject({ status: 'success', result: { ok: true } })
    expect(history.filter(record => record.op === 'process').at(-1)).toMatchObject({ command: 'git status', target: 'runner', status: 'success' })
  })

  it('refuses an empty or non-string command before recording anything', async () => {
    const history: HistoryRecord[] = []
    const runtime = new ApplicationRuntime({ history: { write: record => { history.push(record) } } })
    await runtime.register(processApp({
      ops: {
        run: {
          description: 'run one command',
          effect: 'read',
          params: {},
          result: { type: 'json' },
          execute: async (_args, ctx) => await ctx.process.run({ command: 7 as never }, async () => ({ ok: true })),
        },
      },
    }))
    await runtime.grant({ caller: { kind: 'app', appId: 'runner' }, capabilities: ['capability:process'], grantedAt: at })
    expect(await runtime.call({ kind: 'human' }, 'runner', 'run', {}))
      .toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(history.filter(record => record.op === 'process')).toEqual([])
  })

  it('records a prefixed AppError and an unknown non-Error without inventing an app code', async () => {
    const history: HistoryRecord[] = []
    const runtime = new ApplicationRuntime({ history: { write: record => { history.push(record) } } })
    await runtime.register(processApp({
      ops: {
        run: {
          description: 'run one command',
          effect: 'read',
          params: {},
          result: { type: 'json' },
          execute: async (_args, ctx) => await ctx.process.run({ command: 'git status' }, async () => {
            throw new AppError('platform.git-failed', 'platform said no')
          }),
        },
      },
    }))
    await runtime.grant({ caller: { kind: 'app', appId: 'runner' }, capabilities: ['capability:process'], grantedAt: at })
    await runtime.call({ kind: 'human' }, 'runner', 'run', {})
    expect(history.filter(record => record.op === 'process').at(-1)).toMatchObject({ status: 'failed', code: 'platform.git-failed' })

    const stringRuntime = new ApplicationRuntime({ history: { write: record => { history.push(record) } } })
    await stringRuntime.register(processApp({
      ops: {
        run: {
          description: 'run one command',
          effect: 'read',
          params: {},
          result: { type: 'json' },
          execute: async (_args, ctx) => await ctx.process.run({ command: 'git status' }, async () => { throw 'boom' }),
        },
      },
    }))
    await stringRuntime.grant({ caller: { kind: 'app', appId: 'runner' }, capabilities: ['capability:process'], grantedAt: at })
    await stringRuntime.call({ kind: 'human' }, 'runner', 'run', {})
    expect(history.filter(record => record.op === 'process').at(-1)).toMatchObject({ status: 'failed', code: 'app.threw' })
  })

  it('records a failed command with its stable code and rethrows', async () => {
    const history: HistoryRecord[] = []
    const runtime = new ApplicationRuntime({ history: { write: record => { history.push(record) } } })
    await runtime.register(processApp({
      ops: {
        run: {
          description: 'run one declared command',
          effect: 'read',
          params: {},
          result: { type: 'json' },
          execute: async (_args, ctx) => await ctx.process.run({ command: 'git missing' }, async () => { throw new Error('no git') }),
        },
      },
    }))
    await runtime.grant({ caller: { kind: 'app', appId: 'runner' }, capabilities: ['capability:process'], grantedAt: at })
    expect(await runtime.call({ kind: 'human' }, 'runner', 'run', {}))
      .toMatchObject({ status: 'failed', error: { code: 'platform.execution-failed' } })
    expect(history.filter(record => record.op === 'process').at(-1)).toMatchObject({ command: 'git missing', status: 'failed', code: 'app.threw' })
  })
})
