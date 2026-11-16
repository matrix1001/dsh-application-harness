/**
 * The application area's dedicated conversation target.
 *
 * The application area is a global panel, so its conversation is NOT the main
 * Session borrowed while the panel is open. It is one Session of its own,
 * created in a dedicated Workspace the first time the human opens "应用对话",
 * and remembered by the layout preferences. A Session that has been marked
 * here receives the application tool surface from the host; a normal
 * conversation keeps the standard preset and never sees those tools.
 *
 * The mapping is small UI state (two ids), so it lives in the area's
 * preferences: losing it costs a new conversation, never business data. The
 * Workspace directory is user-visible and is the standard tools' cwd; the
 * business data remains in the application store.
 * @module @matrix1001/dsh-application-harness-client-applications/client/app-conversation
 */

import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ConversationSession } from './conversation-session.ts'
import type { ApplicationPreferences } from './preferences.ts'

/** The application area's remembered conversation identity. */
export interface AppConversationTarget {
  /** The dedicated Workspace that owns the conversation. */
  readonly workspaceId: string
  /** The application-area Session. */
  readonly sessionId: string
}

/** The small structural face of the client Session Controller this module uses. */
export interface AppConversationSessions {
  /** Create a Session in a Workspace (the standard preset is the deployment default). */
  create(options?: { readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string }): Promise<string>
  /** Retain the Session for the pane's lifetime. */
  retain(sessionId: string, options: { readonly source: string }): ConversationSession
}

/** The small structural face of the client Workspace Controller this module uses. */
export interface AppConversationWorkspaces {
  /** Create or resolve a Workspace over a directory. */
  create(input: { readonly path: string }): Promise<{ readonly workspaceId: string; readonly path: string }>
}

/** The one host command this module uses; optional because a keyless composition may not mount it. */
export interface AppConversationRemote {
  readonly registerAppConversation?: (sessionId: string) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
  readonly clearAppConversation?: () => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
  readonly setAppConversationContext?: (sessionId: string, context: JsonValue | null) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
}

/** The current-page pointer the browser hands the host for the application conversation. */
export interface AppConversationPage {
  readonly appId: string
  readonly label: string
  readonly record?: { readonly kind: string; readonly id: string }
}

/** The preference store face this module writes. */
export interface AppConversationPreferences {
  getSnapshot(): ApplicationPreferences
  set(next: ApplicationPreferences): void
}

/** The target service the application area uses. */
export interface AppConversationService {
  /**
   * Open the remembered conversation, or return undefined when the deployment
   * has not been set up yet (the caller then offers the first-use dialog).
   * @returns the retained reference, or undefined.
   */
  open(): Promise<ConversationSession | undefined>
  /**
   * Create the dedicated Workspace and its first application conversation.
   * @param path - an existing or newly created directory chosen by the human.
   * @returns the retained reference.
   */
  setup(path: string): Promise<ConversationSession>
  /** The remembered target, for the pane title/status. */
  target(): AppConversationTarget | undefined
  /**
   * Report (or clear) the page the human is on for the remembered conversation.
   * A no-op before setup; the host verifies the pointer at send time.
   * @param page - the current application page, or undefined to clear.
   */
  setPage(page: AppConversationPage | undefined): Promise<void>
  /**
   * Whether the current page is attached to the next message. Turning it off
   * clears the host pointer immediately; turning it on reports the latest page.
   * @param enabled - the visible chip's state.
   */
  setContextEnabled(enabled: boolean): Promise<void>
}

/** What the service needs. */
export interface AppConversationOptions {
  readonly sessions: AppConversationSessions
  readonly workspaces: AppConversationWorkspaces | undefined
  readonly remote: AppConversationRemote
  readonly preferences: AppConversationPreferences
}

/**
 * Create the application conversation target service.
 * @param options - the Session/Workspace/Remote faces and the preference store.
 * @returns the service the area calls.
 */
export function createAppConversation({
  sessions, workspaces, remote, preferences,
}: AppConversationOptions): AppConversationService {
  /** Mark the Session on the host; a composition without the scoped bridge is not an error here. */
  const mark = async (sessionId: string): Promise<boolean> => {
    if (typeof remote.registerAppConversation !== 'function') return false
    try {
      const result = await remote.registerAppConversation(sessionId)
      return result.ok && result.value
    } catch {
      return false
    }
  }

  /** The last page the browser reported, even before setup created the target. */
  let lastPage: AppConversationPage | undefined
  let contextEnabled = true

  const sendPage = async (): Promise<void> => {
    const target = preferences.getSnapshot().appConversation
    if (target === undefined || typeof remote.setAppConversationContext !== 'function') return
    try {
      await remote.setAppConversationContext(target.sessionId, !contextEnabled || lastPage === undefined ? null : lastPage as unknown as JsonValue)
    } catch {
      // The host context reader is optional; a failed report must not break the
      // application page or the conversation pane.
    }
  }

  const clear = (): void => {
    const { appConversation: _drop, ...rest } = preferences.getSnapshot()
    preferences.set(rest)
    // Drop the host-owned mark too; a stale target must not keep the full tool
    // surface attached after the browser has forgotten it.
    try { void remote.clearAppConversation?.().catch(() => {}) } catch { /* the host is optional here */ }
  }

  return {
    target: () => preferences.getSnapshot().appConversation,

    async setPage(page: AppConversationPage | undefined): Promise<void> {
      lastPage = page
      await sendPage()
    },

    async setContextEnabled(enabled: boolean): Promise<void> {
      contextEnabled = enabled
      await sendPage()
    },

    async open(): Promise<ConversationSession | undefined> {
      const target = preferences.getSnapshot().appConversation
      if (target === undefined) return undefined
      try {
        const reference = sessions.retain(target.sessionId, { source: 'applicationHarnessConversation' })
        await mark(target.sessionId)
        await sendPage()
        return reference
      } catch {
        // The remembered Session/Workspace is gone: forget the target and let
        // the area offer first-use setup again, rather than showing a dead pane.
        clear()
        return undefined
      }
    },

    async setup(path: string): Promise<ConversationSession> {
      const trimmed = path.trim()
      if (trimmed === '') throw new Error('application conversation workspace path is empty')
      if (workspaces === undefined) throw new Error('workspace controller is unavailable')
      const workspace = await workspaces.create({ path: trimmed })
      const sessionId = await sessions.create({ workspaceId: workspace.workspaceId, cwd: workspace.path, agentPreset: 'standard' })
      const next: ApplicationPreferences = {
        ...preferences.getSnapshot(),
        appConversation: { workspaceId: workspace.workspaceId, sessionId },
      }
      preferences.set(next)
      try {
        const reference = sessions.retain(sessionId, { source: 'applicationHarnessConversation' })
        await mark(sessionId)
        await sendPage()
        return reference
      } catch (cause) {
        // The Workspace was created but the pane cannot bind: forget the
        // half-made target so the next attempt is a clean first use.
        clear()
        throw cause
      }
    },
  }
}
