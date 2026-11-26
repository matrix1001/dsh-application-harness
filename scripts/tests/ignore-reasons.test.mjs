import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { unreasonedIgnores } from '../check-ignore-reasons.mjs'

describe('v8 ignore reasons', () => {
  it('accepts a reason, a ranged start with a reason, and a paired stop', () => {
    const text = [
      '/* v8 ignore next -- a browser-only branch */',
      '/* v8 ignore next 3 -- same shape */',
      '/* v8 ignore stop */',
      'code()',
    ].join('\n')
    assert.deepEqual(unreasonedIgnores('x.ts', text), [])
  })

  it('flags an ignore without a reason and reports its line', () => {
    const text = ['const a = 1', '/* v8 ignore next */', 'const b = 2'].join('\n')
    assert.deepEqual(unreasonedIgnores('x.ts', text), [{ line: 2, text: '/* v8 ignore next */' }])
  })
})
