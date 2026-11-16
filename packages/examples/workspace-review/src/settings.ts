/**
 * Settings defaults, normalization and validation.
 *
 * The default source roots are computed from the HOME at call time (never at
 * module load), so a test or a deployment can point the application elsewhere
 * without touching the process environment. Stored settings are normalized
 * field by field: a missing or malformed field falls back to its default,
 * while a `setSettings` argument that is malformed is refused, never silently
 * repaired.
 * @module @matrix1001/dsh-application-harness-workspace-review/settings
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { ReviewSettings, SourceRoots } from './types.ts'

/** The retention ceiling: the plan keeps the newest 20 snapshots. */
export const MAX_REVIEW_RETENTION = 20

/** The default retention. */
export const DEFAULT_REVIEW_RETENTION = 20

/** Resolve the default agent session roots below one home directory. */
export function defaultSourceRoots(
  home: string = homedir(),
  dshHome: string = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(home, '.dsh'),
): SourceRoots {
  return {
    // The host's session store is under DSH_HOME, which is not always
    // `~/.dsh` (an isolated validation instance is the normal case).
    dsh: join(dshHome, 'sessions'),
    claudeCode: join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
  }
}

/** Build the default settings. */
export function defaultReviewSettings(home: string = homedir(), dshHome?: string): ReviewSettings {
  return {
    sourceRoots: defaultSourceRoots(home, dshHome),
    redactSecrets: true,
    reviewRetention: DEFAULT_REVIEW_RETENTION,
    aiEnabled: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function usableRoot(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validRetention(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_REVIEW_RETENTION
}

/**
 * Normalize one stored or defaulted settings document. Malformed fields fall
 * back to the supplied defaults rather than refusing the application: a settings
 * read must never turn into an empty configuration by accident, but it also
 * must not keep a corrupt value that would make the page impossible to open.
 * @param raw - the stored value, if any.
 * @param defaults - the values a missing or malformed field takes.
 * @returns the complete settings.
 */
export function normalizeSettings(raw: unknown, defaults: ReviewSettings): ReviewSettings {
  if (!isRecord(raw)) return { ...defaults, sourceRoots: { ...defaults.sourceRoots } }
  const roots = isRecord(raw.sourceRoots) ? raw.sourceRoots : {}
  return {
    sourceRoots: {
      dsh: usableRoot(roots.dsh) ? roots.dsh.trim() : defaults.sourceRoots.dsh,
      claudeCode: usableRoot(roots.claudeCode) ? roots.claudeCode.trim() : defaults.sourceRoots.claudeCode,
      codex: usableRoot(roots.codex) ? roots.codex.trim() : defaults.sourceRoots.codex,
    },
    redactSecrets: typeof raw.redactSecrets === 'boolean' ? raw.redactSecrets : defaults.redactSecrets,
    reviewRetention: validRetention(raw.reviewRetention) ? raw.reviewRetention : defaults.reviewRetention,
    aiEnabled: typeof raw.aiEnabled === 'boolean' ? raw.aiEnabled : defaults.aiEnabled,
  }
}

/**
 * Merge one settings patch over the current settings. This is the write path:
 * a wrong type or an out-of-range retention is refused with `invalid-args`
 * instead of being normalized into something the caller did not ask for.
 * @param current - the settings in effect.
 * @param patch - the fields to change.
 * @returns the complete next settings.
 * @throws {AppError} `invalid-args` for a malformed field.
 */
export function mergeSettings(current: ReviewSettings, patch: unknown): ReviewSettings {
  if (!isRecord(patch)) throw new AppError('invalid-args', 'settings must be an object')
  const next: ReviewSettings = { ...current, sourceRoots: { ...current.sourceRoots } }
  if (patch.sourceRoots !== undefined) {
    if (!isRecord(patch.sourceRoots)) throw new AppError('invalid-args', 'sourceRoots must be an object')
    for (const key of ['dsh', 'claudeCode', 'codex'] as const) {
      const value = patch.sourceRoots[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.trim() === '') throw new AppError('invalid-args', `sourceRoots.${key} must be a non-empty path string`)
      next.sourceRoots[key] = value.trim()
    }
  }
  if (patch.redactSecrets !== undefined) {
    if (typeof patch.redactSecrets !== 'boolean') throw new AppError('invalid-args', 'redactSecrets must be a boolean')
    next.redactSecrets = patch.redactSecrets
  }
  if (patch.reviewRetention !== undefined) {
    if (!validRetention(patch.reviewRetention)) throw new AppError('invalid-args', `reviewRetention must be an integer from 1 to ${String(MAX_REVIEW_RETENTION)}`)
    next.reviewRetention = patch.reviewRetention
  }
  if (patch.aiEnabled !== undefined) {
    if (typeof patch.aiEnabled !== 'boolean') throw new AppError('invalid-args', 'aiEnabled must be a boolean')
    next.aiEnabled = patch.aiEnabled
  }
  return next
}
