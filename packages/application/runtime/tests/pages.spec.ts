import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration, PageDeclaration } from '../src/index.ts'

function app(pages: Record<string, PageDeclaration>): AppDeclaration {
  return {
    id: 'pages', name: 'Pages', description: 'page declarations', version: '1.0.0',
    pages,
    ops: { noop: { description: 'noop', params: {}, result: { type: 'json' }, execute: () => ({}) } },
  }
}

describe('page declarations', () => {
  it('accepts stable views and fixed actions, and rejects malformed declarations', () => {
    expect(() => new ApplicationRuntime().mount(app({ list: { description: 'list', actions: ['navigate', 'select'] }, detail: { description: 'detail' } }))).not.toThrow()
    expect(() => new ApplicationRuntime().mount(app({ 'Bad View': { description: 'x' } }))).toThrow(/must match/u)
    expect(() => new ApplicationRuntime().mount(app({ list: { description: ' ' } }))).toThrow(/must carry a description/u)
    expect(() => new ApplicationRuntime().mount(app({ list: { description: 'x', actions: [] } }))).toThrow(/invalid or duplicate/u)
    expect(() => new ApplicationRuntime().mount(app({ list: { description: 'x', actions: ['navigate', 'navigate'] } }))).toThrow(/invalid or duplicate/u)
    expect(() => new ApplicationRuntime().mount(app({ list: { description: 'x', actions: ['custom' as never] } }))).toThrow(/invalid or duplicate/u)
  })
})
