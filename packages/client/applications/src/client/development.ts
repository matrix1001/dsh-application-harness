/**
 * Create one application development Session in the human-chosen source
 * workspace and bind it to the app on the host. The source tree stays the
 * ordinary working directory; the host mark is what scopes the app tools and
 * forces per-write confirmation.
 * @module @matrix1001/dsh-application-harness-client-applications/client/development
 */
import type { AppConversationSessions, AppConversationWorkspaces } from './app-conversation.ts'

/** The one development-session host command this module uses. */
export interface DevelopmentRemote {
  readonly registerDevelopmentSession?: (sessionId: string, appId: string) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
}

/** What creating a development session needs. */
export interface DevelopmentOptions {
  readonly sessions: AppConversationSessions
  readonly workspaces: AppConversationWorkspaces | undefined
  readonly remote: DevelopmentRemote
}

/**
 * Create a Workspace over the source path, a Session in it, then bind the
 * Session to the application.
 * @param options - Session/Workspace/Remote faces.
 * @param appId - the application under development.
 * @param path - the source root the human chose.
 * @returns the created Session id.
 */
export async function createDevelopmentSession(
  { sessions, workspaces, remote }: DevelopmentOptions,
  appId: string,
  path: string,
): Promise<string> {
  const trimmed = path.trim()
  if (trimmed === '') throw new Error('development workspace path is empty')
  if (workspaces === undefined) throw new Error('workspace controller is unavailable')
  if (typeof remote.registerDevelopmentSession !== 'function') throw new Error('development sessions are unavailable in this deployment')
  const workspace = await workspaces.create({ path: trimmed })
  const sessionId = await sessions.create({ workspaceId: workspace.workspaceId, cwd: workspace.path, agentPreset: 'standard' })
  const result = await remote.registerDevelopmentSession(sessionId, appId)
  if (!result.ok || !result.value) throw new Error('the host refused the development-session binding')
  return sessionId
}
