/**
 * Workspace attribution: cwd longest-prefix matching, parent inheritance and
 * manual assignment precedence.
 *
 * Manual assignment wins over every automatic rule (and survives a later
 * sync); a session without a matching cwd inherits its parent's workspace; a
 * session whose cwd matches several workspaces belongs to the longest matching
 * root/alias. Nothing here guesses by agent or session content.
 * @module @matrix1001/dsh-application-harness-workspace-review/attribution
 */

import { resolve, sep } from 'node:path'
import type { Session, Workspace } from './types.ts'

/** Normalize one path prefix: absolute and without a trailing separator (except a root). */
export function normalizePrefix(value: string): string {
  return resolve(value)
}

/** Whether one cwd is the root itself or below it. */
export function isWithin(root: string, cwd: string): boolean {
  const prefix = normalizePrefix(root)
  const target = normalizePrefix(cwd)
  if (target === prefix) return true
  return target.startsWith(prefix.endsWith(sep) ? prefix : `${prefix}${sep}`)
}

/**
 * Find the workspace owning one cwd, using the longest matching root or alias.
 * @param cwd - the session's working directory.
 * @param workspaces - all workspaces.
 * @returns the owning workspace, or undefined for an unmatched session.
 */
export function matchWorkspace(cwd: string, workspaces: readonly Workspace[]): Workspace | undefined {
  if (cwd === '') return undefined
  let best: Workspace | undefined
  let bestLength = -1
  for (const workspace of workspaces) {
    for (const prefix of [workspace.root, ...workspace.aliases]) {
      if (!isWithin(prefix, cwd)) continue
      const length = normalizePrefix(prefix).length
      /* v8 ignore next -- overlapping prefixes pick the longest; the shorter branch is exercised */
      if (length > bestLength) { best = workspace; bestLength = length }
    }
  }
  return best
}

/**
 * Resolve each session's parent in one pass over the merged session set.
 * @param sessions - all known sessions.
 * @returns normalized session id → normalized parent id.
 */
export function resolveParents(sessions: readonly Session[]): Map<string, string> {
  const byNative = new Map<string, string>()
  for (const session of sessions) byNative.set(`${session.agent}:${session.nativeId}`, session.id)
  const parents = new Map<string, string>()
  for (const session of sessions) {
    if (session.parentNativeId === undefined) continue
    const parentId = byNative.get(`${session.agent}:${session.parentNativeId}`)
    if (parentId !== undefined && parentId !== session.id) parents.set(session.id, parentId)
  }
  return parents
}

/**
 * Attribute every session to a workspace. The returned map always contains an
 * entry for each session; `undefined` means the session is unmatched and waits
 * for the human. Manual assignments are preserved even when the cwd would now
 * match a different workspace.
 * @param sessions - the merged sessions (their current `assignedBy` is read).
 * @param workspaces - all workspaces.
 * @returns session id → workspace id or undefined.
 */
export function attributeSessions(sessions: readonly Session[], workspaces: readonly Workspace[]): Map<string, string | undefined> {
  const workspaceIds = new Set(workspaces.map(workspace => workspace.id))
  const parents = resolveParents(sessions)
  const assignments = new Map<string, string | undefined>()
  const keepManual = new Set<string>()
  for (const session of sessions) {
    if (session.assignedBy === 'manual' && session.workspaceId !== undefined && workspaceIds.has(session.workspaceId)) {
      assignments.set(session.id, session.workspaceId)
      keepManual.add(session.id)
      continue
    }
    const direct = matchWorkspace(session.cwd, workspaces)
    assignments.set(session.id, direct?.id)
  }
  // Parents first, then children of parents assigned in this same pass. A
  // bounded number of passes handles arbitrary file order without recursion.
  for (let pass = 0; pass < sessions.length; pass += 1) {
    let changed = false
    for (const session of sessions) {
      if (assignments.get(session.id) !== undefined || keepManual.has(session.id)) continue
      const parentId = parents.get(session.id)
      if (parentId === undefined) continue
      const parentWorkspace = assignments.get(parentId)
      if (parentWorkspace === undefined) continue
      assignments.set(session.id, parentWorkspace)
      changed = true
    }
    if (!changed) break
  }
  return assignments
}

/**
 * Count how many sessions have no workspace.
 * @param assignments - the attribution map.
 * @returns the unmatched count.
 */
export function unmatchedCount(assignments: ReadonlyMap<string, string | undefined>): number {
  let count = 0
  for (const workspaceId of assignments.values()) if (workspaceId === undefined) count += 1
  return count
}
