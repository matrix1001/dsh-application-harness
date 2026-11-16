/**
 * The failure classifier (`failure.ts`): a call's outcome read as the one thing
 * a surface has to decide — does this need the human's permission, is it a
 * declaration problem, or is it something else entirely?
 *
 * Every code the runtime can answer with is exercised, plus the three arms that
 * are not a code at all (no answer at all, a success, a cancellation): the
 * classification IS the contract two pages must agree on, so it is pinned
 * exactly.
 */
import { describe, expect, it } from 'vitest'
import type { CallOutcome } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { failureKindOf, hasAppCode, isPermissionKind } from '../src/failure.ts'

/** One rejected outcome (the operation never ran). */
function rejected(code: string): CallOutcome {
  return { callId: 'c1', status: 'rejected', error: { code: `platform.${code}`, message: 'no' } } as CallOutcome
}

/** One failed outcome (the operation ran and failed). */
function failed(code: string): CallOutcome {
  return { callId: 'c1', status: 'failed', error: { code: `app.${code}`, message: 'no' } } as CallOutcome
}

describe('failureKindOf', () => {
  it('names a permission refusal and the kinds a human has to be told apart', () => {
    expect(failureKindOf(failed('capability-not-approved'))).toBe('not-approved')
    expect(failureKindOf(failed('capability-not-approved'))).toBe('not-approved')
    expect(failureKindOf(failed('capability-undeclared'))).toBe('undeclared')
    expect(failureKindOf(rejected('not-open-to-caller'))).toBe('not-open')
    expect(failureKindOf(rejected('caller-not-declared'))).toBe('caller-not-declared')
    expect(failureKindOf(rejected('denied'))).toBe('denied')
    expect(failureKindOf(rejected('confirmation-declined'))).toBe('confirmation')
    expect(failureKindOf(rejected('confirmation-unavailable'))).toBe('confirmation')
  })

  it('reads success, cancellation and an answer that never arrived', () => {
    expect(failureKindOf(undefined)).toBe('transport')
    expect(failureKindOf({ callId: 'c1', status: 'success', result: null })).toBe('other')
    expect(failureKindOf({ callId: 'c1', status: 'cancelled' })).toBe('cancelled')
  })

  it('keeps an application’s own business code out of the permission vocabulary', () => {
    // `stale-version`, `invalid-args`, a domain refusal of its own: all `other`,
    // and none of them may be mistaken for a missing grant.
    expect(failureKindOf(failed('stale-version'))).toBe('other')
    expect(failureKindOf(failed('invalid-args'))).toBe('other')
    expect(failureKindOf(failed('threw'))).toBe('other')
  })

  it('offers the permission way in for exactly one kind', () => {
    expect(isPermissionKind('not-approved')).toBe(true)
    expect(isPermissionKind('undeclared')).toBe(false)
    expect(isPermissionKind('denied')).toBe(false)
    expect(isPermissionKind('transport')).toBe(false)
  })
})

describe('hasAppCode', () => {
  it('accepts the runtime prefix, the bare code and platform-prefixed outcomes', () => {
    expect(hasAppCode(failed('stale-version'), 'stale-version')).toBe(true)
    expect(hasAppCode({ callId: 'c1', status: 'failed', error: { code: 'stale-version', message: 'no' } } as CallOutcome, 'stale-version')).toBe(true)
    expect(hasAppCode(rejected('denied'), 'denied')).toBe(true)
    expect(hasAppCode(failed('stale-version'), 'denied')).toBe(false)
    expect(hasAppCode(undefined, 'stale-version')).toBe(false)
    expect(hasAppCode({ callId: 'c1', status: 'success', result: null }, 'stale-version')).toBe(false)
  })
})
