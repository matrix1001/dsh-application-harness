/**
 * Human-readable formatting for the management surfaces.
 *
 * Management shows byte counts and timestamps; raw bytes and ISO strings are
 * diagnostics, not what a person uses to decide whether to prune or restore.
 * @module @matrix1001/dsh-application-harness-client-applications/client/format
 */

/** One binary byte size in a compact, locale-neutral unit. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}
