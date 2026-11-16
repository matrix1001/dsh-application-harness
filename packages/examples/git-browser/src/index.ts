/**
 * The git-browser Cordis face: one row, one application. The row builds the
 * declaration over the platform's subprocess service, hands it to the runtime
 * (`ctx.applications.register` via {@link mountApplication}) and stops the
 * application when the row unloads.
 *
 * `inject` names the two services the row cannot work without: without the
 * application runtime there is no registry to join, and without the subprocess
 * service there is no way to run git (the row then stays pending instead of
 * registering an application whose every call fails).
 * @module @matrix1001/dsh-application-harness-git-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { gitBrowserDeclaration } from './app.ts'
import { GitProcessRunner } from './subprocess.ts'

/** The `git-browser` row's config. */
export interface GitBrowserConfig {
  /** The git binary to run (absent = `git` from PATH). */
  gitBinary?: string
  /** Per-run wall-clock deadline in ms (absent = 10 s). */
  timeoutMs?: number
  /** Per-stream capture cap in bytes (absent = 1 MiB). */
  maxBytes?: number
}

/** The plugin name (the row id in a composition). */
export const name = 'git-browser'

/** The row config schema (validated before the plugin starts: fail loud). */
export const Config = Schema.object({
  gitBinary: Schema.string(),
  timeoutMs: Schema.number(),
  maxBytes: Schema.number(),
})

/** The services this row binds: the registry it registers into and the process seam it runs git through. */
export const inject = ['applications', 'subprocess']

/**
 * Mount the application: register the declaration and tie its life to this row.
 * @param ctx - the Cordis context (with the runtime and subprocess services injected).
 * @param config - the validated row config.
 * @returns when the application is mounted.
 */
export async function apply(ctx: Context, config: GitBrowserConfig = {}): Promise<void> {
  await mountApplication(ctx, gitBrowserDeclaration({
    run: new GitProcessRunner({
      subprocess: ctx.subprocess,
      ...(config.gitBinary === undefined ? {} : { gitBinary: config.gitBinary }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
    }),
  }))
}

export { gitBrowserDeclaration } from './app.ts'
export type { GitBrowserOptions } from './app.ts'
export {
  DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, MAX_PATCH_BYTES, MAX_PATCH_LINES,
  classifyGitFailure, isEmptyRepository, isBinaryPatch,
  parseCommitFiles, parseLog, parseNumstat, parseShowHeader, parseStatus,
  readLogLimit, readRepoFile, readRepoPath, readRev, readStaged, truncatePatch,
} from './git.ts'
export type {
  CommitDetail, CommitFile, CommitSummary, DiffResult, FileStatus, GitFailureClass,
  LogResult, NumStatEntry, RepoFile, RepoStatus, ShowResult,
} from './git.ts'
export {
  CANCEL_WAIT_MS, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, GitProcessRunner, KILL_GRACE_MS,
} from './subprocess.ts'
export type {
  GitCapabilityDoor, GitCommandResult, GitCommandRunner, GitProcessOptions, GitRunContext,
  SubprocessSpawner,
} from './subprocess.ts'
