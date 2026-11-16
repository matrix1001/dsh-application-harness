/**
 * The shared error vocabulary: cancellations and readable failure messages.
 */
import { describe, expect, it } from 'vitest'
import { abortError, isAbortError, messageOf } from '../src/errors.ts'

describe('error helpers', () => {
  it('recognises only AbortError and always produces a readable message', () => {
    expect(abortError()).toMatchObject({ name: 'AbortError' })
    expect(isAbortError(abortError())).toBe(true)
    expect(isAbortError(new Error('nope'))).toBe(false)
    expect(isAbortError('x')).toBe(false)
    expect(messageOf(new Error('reason'))).toBe('reason')
    expect(messageOf('plain')).toBe('plain')
  })
})
