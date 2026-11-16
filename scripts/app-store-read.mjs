#!/usr/bin/env node
/**
 * Read-only access to the unified application store (`app-data.sqlite`) for the
 * acceptance scripts. A lane's proof that the host saved something must read
 * the same authority the host itself writes — the SQLite namespace — instead of
 * a legacy JSON file that a migrated deployment no longer updates.
 *
 * **Authority order:** when the database exists, its namespace is the answer.
 * A missing document row means the application has no document, not "read the
 * old file": the legacy files are migration sources and stay byte-identical after
 * migration, so reading them would turn a successful save into a false failure
 * and a stale value into a false pass.
 * Only a deployment without the database (no `app-store` row) has a file-backed
 * authority, and that decision belongs to the caller, not to this module.
 *
 * The connection is opened `readOnly`, so a lane can read the live host's
 * database without joining its writes and without touching the WAL.
 * @module scripts/app-store-read
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The unified store's default path inside one harness home (the same
 * `dshHomePath('application-harness/app-data.sqlite')` the deployment binds).
 * @param {string} home - the harness home.
 * @returns {string} the absolute database path.
 */
export function appDataDbPath(home) {
  return join(home, 'application-harness', 'app-data.sqlite')
}

/**
 * Read one application document through the unified store.
 *
 * The result is a STATE, never a default: a caller must be able to tell "the
 * row is absent" from "the database could not be read", because the first is a
 * legitimate empty namespace and the second is a failed readback that must not
 * be reported as success.
 * @param {string} dbPath - the `app-data.sqlite` path.
 * @param {string} appId - the store namespace.
 * @param {string} scope - the document scope.
 * @returns {{state: 'ok', value: unknown, revision: number, updatedAt: number}
 *   | {state: 'missing'}
 *   | {state: 'missing-db'}
 *   | {state: 'unreadable', error: string}} the document or why it is absent.
 */
export function readAppDocument(dbPath, appId, scope) {
  if (!existsSync(dbPath)) return { state: 'missing-db' }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare(
      'SELECT revision, value, updated_at FROM app_documents WHERE app_id = ? AND scope = ?',
    ).get(appId, scope)
    if (row === undefined) return { state: 'missing' }
    return {
      state: 'ok',
      value: JSON.parse(String(row.value)),
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at),
    }
  } catch (error) {
    return { state: 'unreadable', error: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close()
  }
}
