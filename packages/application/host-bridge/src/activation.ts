/**
 * The durable user activation table: which deployed applications the user has
 * disabled. Activation is a user setting, not a grant, a runtime state or a
 * business record; the file contains only application ids.
 * @module @matrix1001/dsh-application-harness-host-bridge/activation
 */

import { readVersionedJson, writeVersionedJson } from './platform-files.ts'

/** The schema version of the stored activation table. */
export const ACTIVATION_TABLE_VERSION = 1

/** File-backed disabled-application set. */
export class ActivationFileStore {
  /**
   * @param path - the JSON file holding the disabled ids.
   */
  constructor(private readonly path: string) {}

  /** Read the disabled ids; a missing file is the empty set. */
  async list(): Promise<readonly string[]> {
    const disabled = await readVersionedJson(
      this.path,
      ACTIVATION_TABLE_VERSION,
      'activation table',
      (document) => disabledOfDocument(document, this.path),
    )
    return disabled ?? []
  }

  /** Replace the disabled set atomically. */
  async save(disabled: readonly string[]): Promise<void> {
    await writeVersionedJson(this.path, ACTIVATION_TABLE_VERSION, { disabled: [...disabled] })
  }
}

function disabledOfDocument(document: Record<string, unknown>, path: string): string[] {
  if (!Array.isArray(document.disabled)) throw new Error(`the activation table ${path} carries no disabled array (the file was left untouched)`)
  const disabled: string[] = []
  for (const value of document.disabled) {
    if (typeof value !== 'string' || value === '') throw new Error(`the activation table ${path} holds a malformed application id (the file was left untouched)`)
    disabled.push(value)
  }
  return disabled
}
