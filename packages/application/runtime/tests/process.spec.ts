import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration } from '../src/index.ts'

function app(process: AppDeclaration['process'], capabilities: readonly string[] = ['process']): AppDeclaration {
  return {
    id: 'proc', name: 'Proc', description: 'process declarations', version: '1.0.0',
    capabilities,
    ...(process === undefined ? {} : { process }),
    ops: { noop: { description: 'noop', params: {}, result: { type: 'json' }, execute: () => ({}) } },
  }
}

describe('process command declarations', () => {
  it('accepts display-only commands and exposes validation failures', () => {
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: 'status', description: 'show status', argv: ['git', 'status'] }, { name: 'log', description: 'show log' }] }))).not.toThrow()
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: '', description: 'x' }] }))).toThrow(/must carry a name/u)
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: ' status', description: 'x' }] }))).toThrow(/surrounding whitespace/u)
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }] }))).toThrow(/repeats/u)
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: 'a', description: ' ' }] }))).toThrow(/must carry a description/u)
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: 'a', description: 'x', argv: [] }] }))).toThrow(/empty argv/u)
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: 'a', description: 'x', argv: [''] }] }))).toThrow(/empty argv/u)
    expect(() => new ApplicationRuntime().mount(app({ commands: [{ name: 'a', description: 'x' }] }, []))).toThrow(/not the process capability/u)
    const { capabilities: _capabilities, ...noCapabilities } = app({ commands: [{ name: 'a', description: 'x' }] })
    expect(() => new ApplicationRuntime().mount(noCapabilities)).toThrow(/not the process capability/u)
  })
})
