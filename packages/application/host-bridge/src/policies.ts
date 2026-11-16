/**
 * The durable operation-policy table: one user override per application
 * operation. It is authorization state, not business data, so it lives next to
 * the harness home (`application-harness/policies.json`) and is written whole through
 * the shared atomic versioned-JSON helper.
 *
 * A missing file is the empty table (every operation uses its author default).
 * A file that exists but cannot be read, parsed or validated rejects; the host
 * must never silently replace approvals with an empty table.
 * @module @matrix1001/dsh-application-harness-host-bridge/policies
 */

import type { OperationPolicyEntry, PolicyStorePort } from '@matrix1001/dsh-application-harness-runtime'
import { isPlainRecord, readVersionedJson, writeVersionedJson } from './platform-files.ts'

/** The schema version of the stored table. */
export const POLICY_TABLE_VERSION = 1

/** File-backed policy table. */
export class PolicyFileStore implements PolicyStorePort {
  /**
   * @param path - the JSON file holding the table.
   */
  constructor(private readonly path: string) {}

  /** Read the stored entries; a missing file answers empty, any other failure rejects. */
  async list(): Promise<readonly OperationPolicyEntry[]> {
    const entries = await readVersionedJson(
      this.path,
      POLICY_TABLE_VERSION,
      'operation policy table',
      (document) => policiesOfDocument(document, this.path),
    )
    return entries ?? []
  }

  /** Replace the table atomically; a failed save rejects. */
  async save(entries: readonly OperationPolicyEntry[]): Promise<void> {
    await writeVersionedJson(this.path, POLICY_TABLE_VERSION, { policies: [...entries] })
  }
}

function policiesOfDocument(document: Record<string, unknown>, path: string): OperationPolicyEntry[] {
  if (!Array.isArray(document.policies)) throw new Error(`the operation policy table ${path} carries no policies array (the file was left untouched)`)
  const entries: OperationPolicyEntry[] = []
  for (const raw of document.policies) {
    if (!isPlainRecord(raw) || typeof raw.appId !== 'string' || raw.appId === ''
      || typeof raw.operation !== 'string' || raw.operation === ''
      || (raw.policy !== 'allow' && raw.policy !== 'confirm' && raw.policy !== 'forbid')
      || typeof raw.updatedAt !== 'string') {
      throw new Error(`the operation policy table ${path} holds a malformed entry (the file was left untouched)`)
    }
    entries.push({
      appId: raw.appId,
      operation: raw.operation,
      policy: raw.policy,
      updatedAt: raw.updatedAt,
    })
  }
  return entries
}
