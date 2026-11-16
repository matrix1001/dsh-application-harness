/**
 * Small error helpers shared by the background runs. They keep the task layer
 * and the user-visible message on one vocabulary: a cancellation is always an
 * `AbortError`, and a failure reason is always a readable string.
 * @module
 */

/** Build the browser-compatible cancellation error the task layer recognises. */
export function abortError(): DOMException {
  return new DOMException('cancelled', 'AbortError')
}

/** Whether an error is a cancellation. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** The readable message of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
