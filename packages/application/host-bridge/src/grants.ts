/**
 * The durable grant table: the harness's own record of what the user has
 * approved, in one JSON file.
 *
 * Authorization state is NOT business data and NOT history: it is the platform's
 * permission record (ARCHITECTURE §5), so it lives with the harness (the
 * `dshHomePath` convention, next to `application-harness/store.json`) rather than in any
 * application's document, and it is written through the shared versioned-JSON
 * helper (`platform-files.ts`), which uses the shared atomic primitive (unique
 * sibling temp + fsync + rename) so a crash leaves the complete old or the
 * complete new table, never a torn one. One `DSH_HOME` has one writer.
 *
 * **A failure never widens access.** The two directions fail in opposite ways
 * on purpose:
 *
 * - a MISSING file is the empty table (nothing was ever approved — the strict
 *   direction), so a fresh home behaves exactly like a fresh installation;
 * - a file that cannot be read, parsed, or validated is an ERROR, never the
 *   empty table. Answering "no grants" would silently discard approvals the
 *   user really made, and the next `save` would then PERSIST that loss; and a
 *   malformed entry is refused for the same reason — the whole table is written
 *   back on every save, so dropping one entry quietly becomes data loss.
 *
 * A `save` that does not reach the rename REJECTS: the runtime reports an
 * approved grant as recorded only after this resolves (ARCHITECTURE §5: a save
 * that did not succeed must not be reported as saved).
 * @module @matrix1001/dsh-application-harness-host-bridge/grants
 */

import type { CapabilityGrant, GrantStorePort } from '@matrix1001/dsh-application-harness-runtime'
import { isPlainRecord, readVersionedJson, writeVersionedJson } from './platform-files.ts'

/** The schema version of the stored table (a future shape is refused, never misread). */
export const GRANT_TABLE_VERSION = 1

/**
 * The durable grant store: one JSON file read and rewritten whole.
 *
 * Every entry is validated on read; a failure of any kind (an unreadable file, a
 * broken document, an unknown version, a malformed entry) rejects rather than
 * answering a partial or empty table, and a failed save rejects rather than
 * reporting success.
 */
export class GrantFileStore implements GrantStorePort {
  /**
   * @param path - the JSON file holding the table.
   */
  constructor(private readonly path: string) {}

  /**
   * Read the stored grants. A missing file answers the empty table; anything
   * else that goes wrong rejects (see the module note).
   * @returns the grants as stored, in stored order.
   * @throws when the file exists but cannot be read, parsed or validated.
   */
  async list(): Promise<readonly CapabilityGrant[]> {
    const grants = await readVersionedJson(
      this.path,
      GRANT_TABLE_VERSION,
      'application grant table',
      (document) => grantsOfDocument(document, this.path),
    )
    return grants ?? []
  }

  /**
   * Replace the stored table with `grants`, atomically (temp write + fsync +
   * rename). The promise rejects when the content did not reach the file, so the
   * caller never reports an approval that is not recorded.
   * @param grants - the complete new table.
   */
  async save(grants: readonly CapabilityGrant[]): Promise<void> {
    await writeVersionedJson(this.path, GRANT_TABLE_VERSION, { grants: [...grants] })
  }
}

/** Validate the grant array inside one versioned document. */
function grantsOfDocument(document: Record<string, unknown>, path: string): CapabilityGrant[] {
  if (!Array.isArray(document.grants)) throw new Error(`the application grant table ${path} carries no grants array (the file was left untouched)`)
  const grants: CapabilityGrant[] = []
  for (const raw of document.grants) {
    const grant = grantOfWire(raw)
    if (grant === undefined) throw new Error(`the application grant table ${path} holds a malformed grant (the file was left untouched)`)
    grants.push(grant)
  }
  return grants
}

/** Validate one stored grant; `undefined` when it is not one. */
function grantOfWire(value: unknown): CapabilityGrant | undefined {
  if (!isPlainRecord(value)) return undefined
  const caller = callerOfWire(value.caller)
  if (caller === undefined) return undefined
  const capabilities = value.capabilities
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some(entry => typeof entry !== 'string' || entry === '')) return undefined
  if (typeof value.grantedAt !== 'string') return undefined
  return { caller, capabilities: capabilities as string[], grantedAt: value.grantedAt }
}

/** Validate one stored caller; `undefined` when it is not one. */
function callerOfWire(value: unknown): CapabilityGrant['caller'] | undefined {
  if (!isPlainRecord(value)) return undefined
  if (value.kind === 'human' || value.kind === 'app' || value.kind === 'background') {
    if (value.kind === 'human') return { kind: 'human' }
    return typeof value.appId === 'string' && value.appId !== '' ? { kind: value.kind, appId: value.appId } : undefined
  }
  if (value.kind !== 'ai') return undefined
  return {
    kind: 'ai',
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
  }
}
