/**
 * The shared versioned-JSON file primitive for the platform's own records.
 *
 * The application harness keeps a small number of host-side records under its
 * home (`grants.json` today; onboarding and history join it in the same line):
 * each is one JSON document with a schema version, read whole and rewritten
 * whole. This module owns that shape once — the version envelope, the
 * missing/corrupt directions and the atomic write — so a new record does not
 * re-invent (or quietly weaken) the protocol.
 *
 * The directions are the caller's to choose:
 *
 * - a missing file answers `undefined` (nothing was ever written);
 * - a file that cannot be read, parsed, or carries another schema version is an
 *   ERROR — never an empty document. A caller that must fail closed (the grant
 *   table) then refuses; a caller that can fail open (the first-run prompt
 *   state) maps the error to empty explicitly, in its own module.
 *
 * The body validation belongs to the caller: `parse` runs after the envelope is
 * checked and may throw its own precise message. Writes go through the shared
 * atomic primitive (unique sibling temp + fsync + rename), so a reader only
 * ever sees the complete old or the complete new document.
 * @module @matrix1001/dsh-application-harness-host-bridge/platform-files
 */

import { readFile } from 'node:fs/promises'
import { isMissingFile, reasonOf, writeFileAtomic } from '@matrix1001/dsh-application-harness-store/atomic'

/**
 * Files this process failed to read/validate. A later save must not replace
 * bytes the process never understood (11 §1.1); only an explicit repair path
 * may override the poison.
 */
const unreadable = new Set<string>()

/**
 * Read one versioned JSON record.
 * @param path - the JSON file to read.
 * @param version - the schema version this build writes.
 * @param noun - what the record is called in error messages (e.g. `application grant table`).
 * @param parse - validates the document body after the version check; may throw.
 * @returns the parsed body, or `undefined` when the file does not exist.
 * @throws when the file exists but cannot be read, parsed, versioned or validated.
 */
export async function readVersionedJson<T>(
  path: string,
  version: number,
  noun: string,
  parse: (document: Record<string, unknown>) => T,
): Promise<T | undefined> {
  try {
    return await readVersionedJsonUnpoisoned(path, version, noun, parse)
  } catch (error) {
    unreadable.add(path)
    throw error
  }
}

/** The actual read/parse path; the public wrapper records failures. */
async function readVersionedJsonUnpoisoned<T>(
  path: string,
  version: number,
  noun: string,
  parse: (document: Record<string, unknown>) => T,
): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(`the ${noun} ${path} cannot be read: ${reasonOf(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`the ${noun} ${path} is not valid JSON (the file was left untouched): ${reasonOf(error)}`)
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`the ${noun} ${path} is not an object (the file was left untouched)`)
  }
  if (parsed.schemaVersion !== version) {
    throw new Error(`the ${noun} ${path} names schema ${JSON.stringify(parsed.schemaVersion)}, this build writes ${String(version)} (the file was left untouched)`)
  }
  return parse(parsed)
}

/**
 * Write one versioned JSON record atomically.
 * @param path - the JSON file to replace.
 * @param version - the schema version written into the envelope.
 * @param body - the document body (the envelope adds `schemaVersion`).
 * @returns when the rename has published the new document.
 * @throws when the content did not reach the file.
 */
export async function writeVersionedJson(
  path: string,
  version: number,
  body: Record<string, unknown>,
  options: { readonly allowAfterReadFailure?: boolean } = {},
): Promise<void> {
  if (unreadable.has(path) && options.allowAfterReadFailure !== true) {
    throw new Error(`the record ${path} could not be read in this process; refusing to overwrite it (repair or restore it first)`)
  }
  await writeFileAtomic(path, JSON.stringify({ schemaVersion: version, ...body }))
  unreadable.delete(path)
}

/**
 * Whether a value is a plain (non-array) record.
 * @param value - the value to inspect.
 * @returns whether it is a plain record.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
