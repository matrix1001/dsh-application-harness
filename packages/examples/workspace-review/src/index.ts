/**
 * The workspace-review Cordis row: one application over the unified `review`
 * namespace, with the platform model port injected by the host.
 *
 * The row performs no reads at load time: it binds storage in the application's
 * start hook and leaves discovery, sync and generation to operations. That way
 * a composition without a granted storage capability still shows the
 * application and its refusal instead of hiding it.
 * @module @matrix1001/dsh-application-harness-workspace-review
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@matrix1001/dsh-application-harness-store'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { createPlatformModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import { WorkspaceReviewApp, WorkspaceReviewDeclaration } from './app.ts'
import { ReviewGenerator } from './generation.ts'
import { ReviewRepository } from './repository.ts'
import { defaultReviewSettings } from './settings.ts'
import { SessionSync } from './sync.ts'

/** The plugin name. */
export const name = 'workspace-review'

/** The runtime and unified-store services this row needs. */
export const inject = ['applications', 'applicationStore']

/**
 * Mount the application.
 * @param ctx - the host context (with the application runtime and store).
 * @param options - test seam for the harness home; deployments omit it.
 */
export async function apply(ctx: Context, options: { home?: string } = {}): Promise<void> {
  const store = ctx.applicationStore
  if (store === undefined) throw new Error('workspace-review requires the application store (ctx.applicationStore)')
  const settings = defaultReviewSettings(options.home)
  const repository = new ReviewRepository(store.gatedNamespace('review'), settings)
  const sync = new SessionSync({ repo: repository })
  const generator = new ReviewGenerator({ model: createPlatformModelPort(ctx, 'workspace-review') })
  const app = new WorkspaceReviewApp({ repo: repository, sync, generator })
  await mountApplication(ctx, WorkspaceReviewDeclaration(app))
}

export { WorkspaceReviewApp, WorkspaceReviewDeclaration } from './app.ts'
export type { GenerateContext, WorkspaceReviewAppOptions } from './app.ts'
export { SessionSync } from './sync.ts'
export type { SessionSyncOptions, SyncContext } from './sync.ts'
export { ReviewRepository } from './repository.ts'
export type { IngestResult } from './repository.ts'
export { ReviewGenerator, buildDeterministic, buildDigest, buildPrompt, resolveRange, selectSessions, validateNarrative } from './generation.ts'
export type { GenerateInput, RangeRequest, ResolvedRange, ReviewGeneratorOptions, SessionDigest } from './generation.ts'
export { discoverSource, isEmptySession, parseClaudeRecords, parseCodexRecords, parseDshRecords, parseSessionFile, parseSessionText, redactSecrets } from './adapters.ts'
export type { DiscoveredSource, ParsedSession, SessionRecordMeta, SourceFile } from './adapters.ts'
export { attributeSessions, matchWorkspace, normalizePrefix, resolveParents } from './attribution.ts'
export { mergeSettings, normalizeSettings, defaultReviewSettings, defaultSourceRoots } from './settings.ts'
export { readGitEvidence, readOptionalEvidence, readTaskEvidence } from './evidence.ts'
export type { OptionalEvidence, PeerCall } from './evidence.ts'
export type * from './types.ts'
