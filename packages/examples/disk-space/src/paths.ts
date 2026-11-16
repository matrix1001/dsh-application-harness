/**
 * Root-relative path rules shared by the scanner, the browse readers and the
 * trash. Every path that comes from the outside is normalised here first: a
 * `..` segment, an absolute path, a backslash or a NUL never reaches the
 * filesystem, and the absolute helpers prove the result stays inside the
 * canonical scan root.
 * @module
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import { resolve as resolvePath, sep } from 'node:path'

/** The root-local directory that holds staged entries (excluded from scans). */
export const TRASH_DIR = '.disk-space-trash'

/**
 * Normalise one root-relative path. An empty string means the scan root.
 * @param value - the caller's path.
 * @returns the canonical `/`-joined relative path.
 * @throws AppError when the path is absolute, contains a traversal segment or
 *   a separator the application does not accept.
 */
export function normalizeRelativePath(value: string): string {
  if (value === '') return ''
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new AppError('path-invalid', `the path ${JSON.stringify(value)} must be root-relative`)
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new AppError('path-invalid', `the path ${JSON.stringify(value)} must not contain empty, "." or ".." segments`)
  }
  return parts.join('/')
}

/** The root-relative parent of one entry (`''` at the top level). */
export function parentPathOf(relative: string): string {
  const index = relative.lastIndexOf('/')
  return index < 0 ? '' : relative.slice(0, index)
}

/** Join one directory and one child name into a root-relative path. */
export function joinRelative(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/** The path's depth (the root is 0). */
export function depthOf(relative: string): number {
  return relative === '' ? 0 : relative.split('/').length
}

/**
 * Resolve one root-relative path to an absolute path and prove it stays in
 * the root. The relative normalisation runs first, so this is the second line
 * of defence for values that were already normalised once.
 * @param root - the canonical absolute root.
 * @param relative - the root-relative path (empty = the root itself).
 * @returns the absolute path inside the root.
 */
export function resolveInside(root: string, relative: string): string {
  const normalized = normalizeRelativePath(relative)
  const target = resolvePath(root, normalized)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new AppError('path-invalid', `the path ${JSON.stringify(relative)} escapes the scan root`)
  }
  return target
}

/**
 * Turn one absolute path back into a root-relative one.
 * @param root - the canonical absolute root.
 * @param absolute - the absolute path to relativise.
 * @returns the root-relative path (`''` for the root itself).
 */
export function relativeToRoot(root: string, absolute: string): string {
  const target = resolvePath(absolute)
  if (target === root) return ''
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!target.startsWith(prefix)) {
    throw new AppError('path-invalid', `the path ${JSON.stringify(absolute)} is outside the scan root`)
  }
  return target.slice(prefix.length).split(sep).join('/')
}

/**
 * Whether one entry is excluded by one of the root-relative rules. A rule
 * excludes its whole subtree.
 * @param relative - the entry's root-relative path.
 * @param excludes - the normalised root-relative rules.
 * @returns whether the entry is skipped.
 */
export function isExcluded(relative: string, excludes: readonly string[]): boolean {
  return excludes.some(exclude => relative === exclude || relative.startsWith(`${exclude}/`))
}

/** Whether one path is the trash directory or lies inside it. */
export function isInsideTrash(relative: string): boolean {
  return relative === TRASH_DIR || relative.startsWith(`${TRASH_DIR}/`)
}
