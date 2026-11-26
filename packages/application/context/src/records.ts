/**
 * What one application's own read operation answers about a cited record, and
 * how this package reads it back.
 *
 * Verification is a READ through the application's declared operations, never a
 * private peek at its storage: the table below names, per application, the
 * operation that answers with the current state and where each record family
 * lives inside its result. The read is taken as the AI caller and only through
 * an operation the application left `open` to the AI — an operation the model
 * may not call is not a read this context may take either, and one that would
 * raise a confirmation question must never be answered by a background
 * verification.
 *
 * Everything else is `unavailable`: an application that is not registered, not
 * available, absent from the table, or whose named operation is missing or not
 * AI-open contributes no context at all — the citation passes through untouched
 * and the model falls back to an ordinary query.
 * @module @matrix1001/dsh-application-harness-context/records
 */

import type { ApplicationRuntime, Caller } from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PageRecordFacts, PageRecordKind, PageRecordReference, PageReference } from './types.ts'

/** How one record family is laid out in its application's read result. */
interface PageRecordFamily {
  /** The result member holding this family's records. */
  readonly collection: string
  /** The field that names the record in one line. */
  readonly labelField: string
  /** The field whose presence marks the record soft-deleted. */
  readonly deletedField: string
}

/** Where one application's page records live, and how to read them back. */
export interface PageRecordSource {
  /** The AI-open read operation that answers with the application's current state. */
  readonly op: string
  /** Where each record family lives in that operation's result. */
  readonly families: Readonly<Partial<Record<PageRecordKind, PageRecordFamily>>>
}

/**
 * The applications this package can verify a citation for. Adding an
 * application is adding a row here: the operation must be one the application
 * declares with `exposure.ai: 'open'`, and each family names the result member
 * its records live in.
 */
export const PAGE_RECORD_SOURCES: Readonly<Record<string, PageRecordSource>> = {
  notes: {
    op: 'contextState',
    families: {
      note: { collection: 'notes', labelField: 'title', deletedField: 'deletedAt' },
    },
  },
  todo: {
    op: 'contextState',
    families: {
      task: { collection: 'tasks', labelField: 'title', deletedField: 'deletedAt' },
    },
  },
}

/**
 * What one citation's verification found. `unavailable` is not a verdict about
 * the record: nothing was read, so nothing may be claimed about it.
 */
export type PageLookup =
  | {
    readonly status: 'found'
    /** The application's declared display name. */
    readonly app: string
    /** The record the citation named; absent when the page itself was cited. */
    readonly record?: PageRecordReference
    /** What the read answered about that record; absent when the page itself was cited. */
    readonly facts?: PageRecordFacts
  }
  | {
    readonly status: 'stale'
    /** The application's declared display name — the application answered, the record did not. */
    readonly app: string
    /** The record that is gone. */
    readonly record: PageRecordReference
  }
  | { readonly status: 'unavailable' }

/** One shared answer, so a pass over many citations allocates none for the common misses. */
const UNAVAILABLE: PageLookup = { status: 'unavailable' }

/**
 * Verify one citation against the application that owns it.
 * @param runtime - the application runtime (the only way this package reads an application).
 * @param caller - who the read is taken as (the AI of the citing turn).
 * @param reference - the parsed citation.
 * @param signal - the turn's cancellation boundary.
 * @returns what the application answered, or `unavailable` when no read could be taken.
 */
export async function lookupPage(
  runtime: ApplicationRuntime,
  caller: Caller,
  reference: PageReference,
  signal: AbortSignal,
): Promise<PageLookup> {
  const registered = runtime.list().find(entry => entry.declaration.id === reference.appId)
  if (registered === undefined || registered.status() !== 'available') return UNAVAILABLE
  const app = registered.declaration.name
  const { record } = reference
  // The page itself was cited: the application answered just by being up.
  if (record === undefined) return { status: 'found', app }
  const source = PAGE_RECORD_SOURCES[reference.appId]
  if (source === undefined) return UNAVAILABLE
  const declaration = registered.declaration.ops[source.op]
  if (declaration === undefined || declaration.exposure?.ai !== 'open') return UNAVAILABLE
  let outcome
  try {
    outcome = await runtime.call(caller, reference.appId, source.op, {}, signal)
  } catch {
    // Authorization/transport failures contribute no context; they must not
    // fail the whole user turn.
    return UNAVAILABLE
  }
  if (outcome.status !== 'success') return UNAVAILABLE
  const family = source.families[record.kind]
  if (family === undefined) return UNAVAILABLE
  const entry = recordsOf(outcome.result as JsonValue, family.collection).find(
    (candidate): candidate is Record<string, JsonValue> => isRecord(candidate) && candidate.id === record.id,
  )
  // The application answered and does not have the record: the citation is
  // stale, and nothing here may guess what the user meant instead.
  if (entry === undefined) return { status: 'stale', app, record }
  return { status: 'found', app, record, facts: factsOf(record, family, entry) }
}

/**
 * The records of one family out of a read result: the named member, when the
 * result really is an object carrying an array there.
 * @param value - the operation's result value.
 * @param collection - the result member to read.
 * @returns the records, or none when the result does not carry that member.
 */
function recordsOf(value: JsonValue, collection: string): readonly JsonValue[] {
  if (!isRecord(value)) return []
  const list = value[collection]
  return Array.isArray(list) ? list as readonly JsonValue[] : []
}

/**
 * The minimal facts one record contributes: its label, and the flags that say
 * it is out of the live view.
 * @param record - the cited record (kind + id, already matched).
 * @param family - how this record's family is laid out.
 * @param fields - the record's own value.
 * @returns the facts.
 */
function factsOf(record: PageRecordReference, family: PageRecordFamily, fields: Record<string, JsonValue>): PageRecordFacts {
  const label = labelOf(fields, family)
  return {
    kind: record.kind,
    id: record.id,
    ...(label === undefined ? {} : { label }),
    ...(marked(fields, family.deletedField) ? { deleted: true as const } : {}),
  }
}

/**
 * The record's label as {@link PageRecordFamily.labelField} holds it: kept whole
 * for a title, reduced to one bounded line for a body.
 * @param fields - the record's own value.
 * @param family - the family layout.
 * @returns the label, or undefined when the field carries no usable text.
 */
function labelOf(fields: Record<string, JsonValue>, family: PageRecordFamily): string | undefined {
  const raw = fields[family.labelField]
  if (typeof raw !== 'string' || raw === '') return undefined
  return raw
}

/**
 * Whether a marker field is set. A boolean flag's own `false` is "not set", and
 * an absent field is not set; any other value (a soft-delete stamp, a `true`)
 * is.
 * @param fields - the record's own value.
 * @param field - the family's marker field.
 * @returns whether the marker is set.
 */
function marked(fields: Record<string, JsonValue>, field: string): boolean {
  const value = fields[field]
  return value !== undefined && value !== false
}

/**
 * Whether a JSON value is an object with members (never an array or null).
 * @param value - the value to test.
 * @returns the value as a member table, or false.
 */
function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
