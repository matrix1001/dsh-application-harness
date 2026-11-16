/**
 * The narrow argument readers every operation shares. The runtime validates
 * the declared JSON schema before an operation executes; these readers are
 * the application's own second check for values that would otherwise reach
 * the filesystem (a missing root, a negative page offset, a path list that is
 * not a string array). Each one throws the runtime's `AppError` so the caller
 * sees the same structured rejection the declaration promises.
 * @module
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'

/** The integer bounds one page control accepts. */
export interface Bounds {
  /** The smallest accepted value. */
  min: number
  /** The largest accepted value. */
  max: number
}

/**
 * Read one operation's argument object.
 * @param value - the raw argument value.
 * @returns the object as a plain record.
 * @throws AppError when the value is not a JSON object.
 */
export function objectArgs(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('invalid-args', 'the operation arguments must be an object')
  }
  return value as Record<string, unknown>
}

/**
 * Read one required non-empty string.
 * @param args - the argument object.
 * @param key - the field name.
 * @returns the string (untrimmed: a path's spaces may be meaningful).
 * @throws AppError when the field is missing or not a non-empty string.
 */
export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw new AppError('invalid-args', `${key} must be a non-empty string`)
  }
  return value
}

/**
 * Read one optional string; absent or `null` reads as undefined.
 * @param args - the argument object.
 * @param key - the field name.
 * @returns the string, or undefined when the caller omitted it.
 * @throws AppError when the field is present but not a non-empty string.
 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new AppError('invalid-args', `${key} must be a non-empty string when given`)
  }
  return value
}

/**
 * Read one optional string that may be empty (a path field where the root is
 * spelled as `''`). Absent or `null` reads as undefined.
 * @param args - the argument object.
 * @param key - the field name.
 * @returns the string, or undefined when the caller omitted it.
 * @throws AppError when the field is present but not a string.
 */
export function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('invalid-args', `${key} must be a string when given`)
  return value
}

/**
 * Read one optional integer inside its bounds.
 * @param args - the argument object.
 * @param key - the field name.
 * @param fallback - the value used when the caller omitted the field.
 * @param bounds - the inclusive accepted range.
 * @returns the integer.
 * @throws AppError when the value is not an integer in range.
 */
export function optionalInteger(args: Record<string, unknown>, key: string, fallback: number, bounds: Bounds): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new AppError('invalid-args', `${key} must be an integer between ${String(bounds.min)} and ${String(bounds.max)}`)
  }
  return value
}

/**
 * Read one optional boolean.
 * @param args - the argument object.
 * @param key - the field name.
 * @param fallback - the value used when the caller omitted the field.
 * @returns the boolean.
 * @throws AppError when the value is present and not a boolean.
 */
export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new AppError('invalid-args', `${key} must be a boolean`)
  return value
}

/**
 * Read one optional array of non-empty strings.
 * @param args - the argument object.
 * @param key - the field name.
 * @returns the strings (empty when absent).
 * @throws AppError when the value is present but not an array of non-empty strings.
 */
export function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new AppError('invalid-args', `${key} must be an array of non-empty strings`)
  }
  return [...value]
}

/**
 * Read one required non-empty array of strings with a bounded length.
 * @param args - the argument object.
 * @param key - the field name.
 * @param max - the largest accepted number of items.
 * @returns the deduplicated strings, in the caller's order.
 * @throws AppError when the field is absent, empty, too long or not a string array.
 */
export function requiredStringArray(args: Record<string, unknown>, key: string, max: number): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length === 0 || value.length > max
    || value.some(item => typeof item !== 'string' || item === '')) {
    throw new AppError('invalid-args', `${key} must be a non-empty array of at most ${String(max)} non-empty strings`)
  }
  return [...new Set(value)]
}
