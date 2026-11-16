/**
 * The shared **narrowing primitives** every world view needs when it reads a
 * raw projection value: "is this a record", "a finite number or the fallback",
 * "a string or the fallback", "the string members of a list".
 *
 * Why they live here: each view package used to declare its own copy, and the
 * copies drifted by name while staying byte-identical in body (`numOf` vs
 * `finiteOr`, `strOf` vs `stringOr`, `stringListOf` vs `stringList`) — a
 * renaming pass would silently have picked whichever local one it found first.
 * The several genuinely different narrows stay local: a helper that clamps to
 * non-negative integers, keeps `undefined` for an unknown measurement, or
 * demands a non-empty `root` is a *policy*, not a primitive, and folding it in
 * here would blur that. Same inlining rule as the rest of this package (see
 * the package README): a consumer's bundle carries its own private copy.
 * @module
 */

/**
 * Whether `value` is a plain object — not null, not an array. The one shape
 * test every projection narrow starts from.
 * @param value - the value to test.
 * @returns whether the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A finite number, or the fallback (a malformed count must never render as
 * `NaN`).
 * @param value - the raw value.
 * @param fallback - what a non-finite / non-number value reads as.
 * @returns the finite number, or the fallback.
 */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A string, or the fallback (defaults to the empty string — a missing label
 * reads as blank, never as the literal `undefined`).
 * @param value - the raw value.
 * @param fallback - what a non-string value reads as.
 * @returns the string, or the fallback.
 */
export function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * The string members of a raw list (a non-list reads as empty; a mixed list
 * keeps only its string members).
 * @param value - the raw value.
 * @returns the string members.
 */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
