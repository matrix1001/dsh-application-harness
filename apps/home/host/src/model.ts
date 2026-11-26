/**
 * The home application's domain model: the durable activity log it keeps from
 * the events it receives, plus the shapes the page renders. Everything here is
 * a pure function over its inputs (or a deterministic generator), so the module
 * is testable without a runtime, a network or a clock.
 *
 * The home page never caches another application's data: the cards are read
 * through peer calls on demand, and only the activity log (a record of notices
 * this application received) is durable.
 * @module @matrix1001/dsh-application-harness-home/model
 */

/** The application id (the registry key, the view registry key and the row id). */
export const HOME_APP_ID = 'home'
/** The unified-store namespace this application owns. */
export const HOME_NAMESPACE = 'home'
/** The durable document version this application reads and writes. */
export const HOME_SCHEMA_VERSION = 1
/** The declaration version (kept in step with the package version). */
export const HOME_VERSION = '0.1.1-dev.0'
/** The application's display identity. */
export const HOME_NAME = '主页'
/** One line about what the application is for. */
export const HOME_DESCRIPTION = '总览各应用的状态与最近发生的变化'

/** The most activity entries the log keeps; older ones fall off. */
export const MAX_ACTIVITIES = 5
/** The most references one activity records (the publisher caps its own list too). */
export const MAX_ACTIVITY_REFS = 50
/** The preview length of one card section. */
export const PREVIEW_ITEMS = 3
/** The longest failure code one card carries. */
export const MAX_CARD_FAILURE_CODE = 80
/** The longest failure message one card carries; one line, never a stack. */
export const MAX_CARD_FAILURE_MESSAGE = 200

/**
 * Why one card's peer read failed, in the same closed vocabulary the client's
 * failure classifier uses. A card may say "not approved" or "not declared"
 * (the two a human can tell apart) without shipping a raw stack or prose.
 */
export type CardFailureKind =
  | 'not-approved'
  | 'undeclared'
  | 'not-open'
  | 'caller-not-declared'
  | 'denied'
  | 'confirmation'
  | 'transport'
  | 'other'

/** The bounded failure a card may carry; details and stacks never cross. */
export interface CardFailure {
  readonly kind: CardFailureKind
  /** The outcome's stable wire code, bounded. */
  readonly code?: string
  /** The outcome's readable message, one bounded line. */
  readonly message?: string
}

/**
 * Classify one failed outcome's wire code.
 * @param code - the outcome's stable code, when it carried one.
 * @returns the kind a card reports.
 */
export function cardFailureKindOf(code: string | undefined): CardFailureKind {
  switch (code) {
    case 'app.capability-not-approved': return 'not-approved'
    case 'app.capability-undeclared': return 'undeclared'
    case 'platform.not-open-to-caller': return 'not-open'
    case 'platform.caller-not-declared': return 'caller-not-declared'
    case 'platform.denied': return 'denied'
    case 'platform.confirmation-declined':
    case 'platform.confirmation-unavailable': return 'confirmation'
    default: return 'other'
  }
}

/** Keep one wire detail readable and bounded: first line only, no stack. */
function bounded(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  const firstLine = value.split(/\r?\n/u, 1)[0]?.trim() ?? ''
  if (firstLine === '') return undefined
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine
}

/**
 * Build the bounded failure one card may report.
 * @param code - the outcome's stable wire code, when it carried one.
 * @param message - the outcome's readable message, when it carried one.
 * @returns the classified kind plus both fields, each capped and single-line.
 */
export function cardFailure(code: string | undefined, message: string | undefined): CardFailure {
  const boundedCode = bounded(code, MAX_CARD_FAILURE_CODE)
  const boundedMessage = bounded(message, MAX_CARD_FAILURE_MESSAGE)
  return {
    kind: cardFailureKindOf(code),
    ...(boundedCode === undefined ? {} : { code: boundedCode }),
    ...(boundedMessage === undefined ? {} : { message: boundedMessage }),
  }
}

/** One reference an event carried: only identity, never content. */
export interface ActivityRef {
  readonly type: string
  readonly id: string
}

/** One notice this application received, as kept in its own document. */
export interface Activity {
  readonly id: string
  readonly appId: string
  readonly type: string
  readonly at: number
  readonly count: number
  readonly refs: ActivityRef[]
}

/** The whole durable document. */
export interface HomeDocument {
  schemaVersion: 1
  activities: Activity[]
}

/** The empty first-run document. */
export function emptyDocument(): HomeDocument {
  return { schemaVersion: HOME_SCHEMA_VERSION, activities: [] }
}

/**
 * Build one activity from a received event.
 * @param appId - the publishing application.
 * @param type - the event type.
 * @param eventId - the platform-generated event id (also the dedupe key).
 * @param at - when the change happened (the event's own timestamp).
 * @param refs - the references the event carried.
 * @returns the bounded activity record.
 */
export function activityFrom(appId: string, type: string, eventId: string, at: number, refs: readonly ActivityRef[]): Activity {
  const bounded = refs.slice(0, MAX_ACTIVITY_REFS)
  return { id: eventId, appId, type, at, count: bounded.length, refs: bounded }
}

/**
 * Put one activity at the front of the log, keeping the newest {@link MAX_ACTIVITIES}.
 * A repeated event id is ignored, so a duplicate delivery never doubles a row.
 * @param document - the current document.
 * @param activity - the activity to record.
 * @returns the next document (the same object when nothing changed).
 */
export function appendActivity(document: HomeDocument, activity: Activity): HomeDocument {
  if (document.activities.some(entry => entry.id === activity.id)) return document
  return { ...document, activities: [activity, ...document.activities].slice(0, MAX_ACTIVITIES) }
}

/** Whether one untrusted value is a document this application can read. */
export function isHomeDocument(value: unknown): value is HomeDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<HomeDocument>
  if (document.schemaVersion !== HOME_SCHEMA_VERSION || !Array.isArray(document.activities)) return false
  return document.activities.every(entry => typeof entry === 'object' && entry !== null
    && typeof (entry as Activity).id === 'string'
    && typeof (entry as Activity).appId === 'string'
    && typeof (entry as Activity).type === 'string'
    && typeof (entry as Activity).at === 'number'
    && typeof (entry as Activity).count === 'number'
    && Array.isArray((entry as Activity).refs))
}

/** A `YYYY-MM-DD` date in the host's local zone (the todo app's due-date format). */
export function localDate(now: number): string {
  const date = new Date(now)
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
