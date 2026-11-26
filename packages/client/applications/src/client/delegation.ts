/**
 * The human's send dialog for a pending delegation.
 *
 * A page can prepare a pending delegation through its application (the
 * platform decides, not the browser), but it can never send one. The page asks
 * the shell to offer the delegation to the human; the shell fetches the
 * platform's record and parks ONE send request here. The application area
 * renders it: the application's instructions are read-only, the human picks an
 * application-area Session and may add a supplement, then sends. The request is
 * UI state only — the durable record, the send and the state machine belong to
 * the host bridge.
 * @module @matrix1001/dsh-application-harness-client-applications/client/delegation
 */

import { createSnapshotStore, type SnapshotStore } from '@matrix1001/dsh-application-harness-client-chrome'
import type { DelegationInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'

/** How the human ended one send dialog. */
export type DelegationSendResult = 'sent' | 'cancelled' | 'unavailable'

/** One pending send request: the record and the dialog's answer channel. */
export interface DelegationSendRequest {
  readonly id: number
  /** The platform record (application instructions are read-only). */
  readonly delegation: DelegationInfo
  readonly resolve: (result: DelegationSendResult) => void
}

/** The one-shot send-request store. */
export interface DelegationService {
  readonly state: SnapshotStore<DelegationSendRequest | undefined>
  /** Offer one pending delegation to the human; a newer request supersedes the older. */
  request(delegation: DelegationInfo): Promise<DelegationSendResult>
  /** Resolve the current request with the human's answer. */
  answer(result: DelegationSendResult): void
}

/** Create the store. */
export function createDelegation(): DelegationService {
  const state = createSnapshotStore<DelegationSendRequest | undefined>(undefined)
  let serial = 0
  return {
    state,
    request(delegation) {
      const previous = state.getSnapshot()
      previous?.resolve('unavailable')
      return new Promise((resolve) => {
        state.set({ id: ++serial, delegation, resolve })
      })
    },
    answer(result) {
      const current = state.getSnapshot()
      if (current === undefined) return
      state.set(undefined)
      current.resolve(result)
    },
  }
}
