/**
 * How a call failed, in the vocabulary a human needs — read from the outcome's
 * own `status`/`code`, never from its message.
 *
 * The runtime answers every call with its closed set of codes, and the copy a
 * surface shows depends on WHICH one: "you must approve this" (and the way to
 * the permission page), "the application never declared it" (a declaration
 * problem an approval cannot fix), "the operation is not open to you", "the
 * request was refused", "the answer never arrived". Reading the message's
 * wording would make the interface follow the host's prose; the code is the
 * contract.
 *
 * Pure and type-only over the wire vocabulary: every surface that reports a
 * failure classifies it here, so two pages never disagree about what one code
 * means.
 * @module
 */

import type { CallOutcome } from '@matrix1001/dsh-application-harness-host-bridge/client'

/** What a failed call means for the human reading the screen. */
export type FailureKind =
  /** `capability-not-approved`: the platform capability needs the human's approval. */
  | 'not-approved'
  /** `capability-undeclared`: the application never declared it — approval cannot fix it. */
  | 'undeclared'
  /** `not-open-to-caller`: the operation is not open to this caller. */
  | 'not-open'
  /** `caller-not-declared`: this caller never declared the call. */
  | 'caller-not-declared'
  /** `denied`: the user (or a stored grant) refused. */
  | 'denied'
  /** `confirmation-declined` / `confirmation-unavailable`: the confirmation path ended without an answer. */
  | 'confirmation'
  /** The caller cancelled it. */
  | 'cancelled'
  /** The answer never arrived (the carrier broke, the method unloaded). */
  | 'transport'
  /** A business failure with a code this vocabulary does not name. */
  | 'other'

/** The codes that mean "a permission is missing and a human can grant it". */
const NOT_APPROVED = 'app.capability-not-approved'

/**
 * Classify one call outcome, or one call whose answer never arrived.
 * @param outcome - the runtime's four-way result, or `undefined` when the call rejected.
 * @returns the kind the surface reports.
 */
export function failureKindOf(outcome: CallOutcome | undefined): FailureKind {
  if (outcome === undefined) return 'transport'
  if (outcome.status === 'success') return 'other'
  if (outcome.status === 'cancelled') return 'cancelled'
  switch (outcome.error?.code) {
    case NOT_APPROVED: return 'not-approved'
    case 'app.capability-undeclared': return 'undeclared'
    case 'platform.not-open-to-caller': return 'not-open'
    case 'platform.caller-not-declared': return 'caller-not-declared'
    case 'platform.denied': return 'denied'
    case 'platform.confirmation-declined':
    case 'platform.confirmation-unavailable': return 'confirmation'
    default: return 'other'
  }
}

/**
 * Whether one failed outcome carries a stable application code, with or without
 * the runtime's `app.` prefix. The wire prefixes business failures; older test
 * fixtures and a few host seams still use the bare code, so both are accepted
 * at the one comparison point instead of every page repeating the rule.
 * @param outcome - the call outcome to inspect.
 * @param code - the bare application code (for example `stale-version`).
 * @returns true when the outcome failed with that code.
 */
export function hasAppCode(outcome: CallOutcome | undefined, code: string): boolean {
  if (outcome === undefined || outcome.status === 'success' || outcome.status === 'cancelled') return false
  const actual = outcome.error?.code
  return actual === `app.${code}` || actual === code || actual === `platform.${code}`
}

/**
 * Whether one kind is a missing permission the human can grant from the
 * application's own permission page — the only kind that may offer that way in.
 * @param kind - the kind a surface classified.
 * @returns true for the grantable kinds.
 */
export function isPermissionKind(kind: FailureKind): boolean {
  return kind === 'not-approved'
}

/** The diagnostic half of a failed call: the wire's own facts, never parsed. */
export interface FailureDetail {
  /** The stable code, when the outcome carried one. */
  readonly code?: string | undefined
  /** The host's own message, when it carried one. */
  readonly message?: string | undefined
}
