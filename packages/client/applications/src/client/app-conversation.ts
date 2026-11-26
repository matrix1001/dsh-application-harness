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

/**
 * The retain options this pane uses. The reference renders the platform
 * Conversation, so it must keep the `conversation` facet: without it the
 * Conversation assembly does not fold the Session's event window and the pane
 * shows an empty or stale transcript.
 */
export interface AppConversationRetainOptions {
  readonly source: string
  /** Keep the platform Conversation facet for this Session. */
  readonly facets?: { readonly conversation?: true }
}

/** The small structural face of the client Session Controller this module uses. */
export interface AppConversationSessions {
  /** Create a Session in a Workspace (the standard preset is the deployment default). */
  create(options?: { readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string }): Promise<string>
  /** Retain the Session for the pane's lifetime. */
  retain(sessionId: string, options: AppConversationRetainOptions): ConversationSession
  /** The platform's Session list snapshot, used to tell a remembered target from a deleted one. */
  readonly list?: {
    getSnapshot(): { readonly byId: Readonly<Record<string, { readonly sessionId: string }>> }
  }
}

/** The small structural face of the client Workspace Controller this module uses. */
export interface AppConversationWorkspaces {
  /** Create or resolve a Workspace over a directory. */
  create(input: { readonly path: string }): Promise<{ readonly workspaceId: string; readonly path: string }>
  /** The Host-authoritative archive set; archived Sessions must not reopen as the area target. */
  readonly list?: {
    getSnapshot(): {
      readonly archivedSessionIds?: readonly string[]
      /** Workspace rows as the platform exposes them (shape differs by client release). */
      readonly workspaces?: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[]
      readonly byId?: Readonly<Record<string, { readonly workspaceId: string; readonly sessionIds?: readonly string[] }>>
    }
  }
}

/** The one host command this module uses; optional because a keyless composition may not mount it. */
export interface AppConversationRemote {
  /** The host's absolute suggested path for a first-use Workspace. */
  readonly suggestedAppConversationPath?: () => Promise<
    { readonly ok: true; readonly value: string } | { readonly ok: false }
  >
  readonly prepareAppConversationWorkspace?: (path: string) => Promise<
    { readonly ok: true; readonly value: string } | { readonly ok: false }
  >
  readonly registerAppConversation?: (sessionId: string) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
  readonly clearAppConversation?: (sessionId?: string) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
  readonly setAppConversationContext?: (sessionId: string, context: JsonValue | null) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
  /** The host's authoritative application-area Session list, for merging on area open. */
  readonly appConversations?: () => Promise<
    { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false }
  >
}

/** The current-page pointer the browser hands the host for the application conversation. */
export interface AppConversationPage {
  readonly appId: string
  readonly label: string
  readonly record?: { readonly kind: string; readonly id: string }
  readonly view?: string
  readonly draftId?: string
  readonly selection?: readonly { readonly kind: string; readonly id: string }[]
  readonly filters?: Readonly<Record<string, string | number | boolean | null>>
  readonly visibleRange?: { readonly from?: string; readonly to?: string }
  readonly hasUnsavedChanges?: boolean
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
  /** Every remembered application-area conversation, in creation order. */
  targets(): readonly AppConversationTarget[]
  /**
   * Merge the host's authoritative Session list into the remembered targets.
   * A target the platform no longer has is removed; an archived target stays
   * remembered but hidden; a host-marked Session the browser forgot is
   * restored when its Workspace can be resolved.
   * @returns when the merge and its host cleanups have settled.
   */
  reconcile(): Promise<void>
  /** Select one remembered conversation and retain it for the pane. */
  select(sessionId: string): Promise<ConversationSession | undefined>
  /** Create another conversation in the area's existing workspace. */
  create(): Promise<ConversationSession>
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
   * @param sessionId - the Session the switch applies to; defaults to the active target.
   */
  setContextEnabled(enabled: boolean, sessionId?: string): Promise<void>
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
  /**
   * Mark the Session on the host. A composition without the scoped bridge is
   * allowed (the Session stays a normal conversation); an explicit refusal from
   * the host is an error the caller must not hide.
   */
  const mark = async (sessionId: string): Promise<'ok' | 'unavailable' | 'refused'> => {
    /* v8 ignore next 2 -- a composition without the scoped bridge is covered by the open-no-bridge test */
    if (typeof remote.registerAppConversation !== 'function') return 'unavailable'
    try {
      const result = await remote.registerAppConversation(sessionId)
      if (!result.ok) return 'unavailable'
      return result.value ? 'ok' : 'refused'
    } catch {
      return 'unavailable'
    }
  }

  /** Mark a Session and fail loudly when the host refuses to register it. */
  const markOrThrow = async (sessionId: string): Promise<void> => {
    if (await mark(sessionId) === 'refused') {
      throw new Error('the host refused to register this application conversation')
    }
  }

  const remembered = (): readonly AppConversationTarget[] => {
    const snapshot = preferences.getSnapshot()
    return snapshot.appConversations ?? (snapshot.appConversation === undefined ? [] : [snapshot.appConversation])
  }

  /** An archived Session is still retainable, but it must never own the area pane. */
  const archived = (sessionId: string): boolean => {
    const snapshot = workspaces?.list?.getSnapshot()
    return snapshot?.archivedSessionIds?.includes(sessionId) === true
  }

  const remember = (targets: readonly AppConversationTarget[], active: AppConversationTarget | undefined): void => {
    const snapshot = preferences.getSnapshot()
    preferences.set({
      ...snapshot,
      ...(active === undefined ? { appConversation: undefined } : { appConversation: active }),
      appConversations: targets,
    })
  }

  /** The platform's live Session ids, or undefined when its list is not readable yet. */
  const liveSessions = (): ReadonlySet<string> | undefined => {
    const snapshot = sessions.list?.getSnapshot()
    return snapshot === undefined ? undefined : new Set(Object.keys(snapshot.byId))
  }

  /** Resolve the Workspace that owns one Session, when the platform exposes the grouping. */
  const workspaceIdOf = (sessionId: string): string | undefined => {
    /* v8 ignore next -- compositions without a workspace list simply cannot restore a target */
    const snapshot = workspaces?.list?.getSnapshot()
    const row = snapshot?.workspaces?.find(workspace => workspace.sessionIds.includes(sessionId))
    if (row !== undefined) return row.workspaceId
    for (const value of Object.values(snapshot?.byId ?? {})) {
      /* v8 ignore next -- a workspace row without a session list cannot own this Session */
      if (value.sessionIds?.includes(sessionId) === true) return value.workspaceId
    }
    return undefined
  }

  /** The last page the browser reported, even before setup created the target. */
  let lastPage: AppConversationPage | undefined
  /** Per-Session attachment switches; absent means attached. */
  const contextEnabled = new Map<string, boolean>()

  /** Drop the previous target's host pointer when the dock switches Sessions. */
  const clearHostContext = async (sessionId: string | undefined): Promise<void> => {
    if (sessionId === undefined || typeof remote.setAppConversationContext !== 'function') return
    try { await remote.setAppConversationContext(sessionId, null) } catch { /* host context is optional */ }
  }

  const sendPage = async (): Promise<void> => {
    const target = preferences.getSnapshot().appConversation
    if (target === undefined || typeof remote.setAppConversationContext !== 'function') return
    try {
      /* v8 ignore next -- the disabled/empty page half is covered by the context-switch tests */
      await remote.setAppConversationContext(target.sessionId, contextEnabled.get(target.sessionId) === false || lastPage === undefined ? null : lastPage as unknown as JsonValue)
    } catch {
      // The host context reader is optional; a failed report must not break the
      // application page or the conversation pane.
    }
  }

  const clear = (): void => {
    const current = preferences.getSnapshot().appConversation
    /* v8 ignore next -- clear is only called for a remembered target */
    if (current === undefined) return
    const remaining = remembered().filter(target => target.sessionId !== current.sessionId && !archived(target.sessionId))
    remember(remaining, remaining[0])
    try { void remote.clearAppConversation?.(current.sessionId).catch(() => {}) } catch { /* the host is optional here */ }
  }

  /** Forget one remembered target (used when it is no longer a live application conversation). */
  const drop = (sessionId: string): void => {
    const current = preferences.getSnapshot().appConversation
    const remaining = remembered().filter(target => target.sessionId !== sessionId && !archived(target.sessionId))
    remember(remaining, current?.sessionId === sessionId ? remaining[0] : current)
    try { void remote.clearAppConversation?.(sessionId).catch(() => {}) } catch { /* the host is optional here */ }
  }

  return {
    target: () => preferences.getSnapshot().appConversation,
    targets: () => remembered().filter(target => !archived(target.sessionId)),

    async reconcile(): Promise<void> {
      const host = remote.appConversations === undefined
        ? undefined
        : await remote.appConversations().catch(() => ({ ok: false as const }))
      if (host !== undefined && !host.ok) return
      const hostIds = host?.ok === true ? host.value : []
      const live = liveSessions()
      const archivedSet = new Set(workspaces?.list?.getSnapshot()?.archivedSessionIds ?? [])
      const previous = remembered()
      const merged: AppConversationTarget[] = []
      const seen = new Set<string>()
      for (const sessionId of hostIds) {
        if (seen.has(sessionId)) continue
        /* v8 ignore next -- a host mark for a Session the platform list does not know is a stale mark */
        if (live !== undefined && !live.has(sessionId)) continue
        /* v8 ignore next -- a host-only mark has no remembered workspace */
        const known = previous.find(target => target.sessionId === sessionId)
        /* v8 ignore next -- restored host targets fall back to the workspace snapshot */
        const workspaceId = known?.workspaceId ?? workspaceIdOf(sessionId)
        if (workspaceId === undefined) continue
        merged.push({ workspaceId, sessionId })
        seen.add(sessionId)
      }
      for (const target of previous) {
        /* v8 ignore next -- the host loop above already added every overlapping target */
        if (seen.has(target.sessionId)) continue
        merged.push(target)
        seen.add(target.sessionId)
      }
      // A host-listed Session the platform no longer has is genuinely stale:
      // drop it even though the browser remembered it. A remembered Session the
      // host does not list is left alone (its mark may still be pending).
      const removed = new Set(
        live === undefined
          ? []
          : previous.filter(target => hostIds.includes(target.sessionId) && !live.has(target.sessionId)).map(target => target.sessionId),
      )
      const kept = removed.size === 0 ? merged : merged.filter(target => !removed.has(target.sessionId))
      const active = preferences.getSnapshot().appConversation
      const nextActive = active === undefined ? undefined : kept.find(target => target.sessionId === active.sessionId)
      remember(kept, nextActive ?? kept.find(target => !archivedSet.has(target.sessionId)))
      // Clean marks for Sessions the platform no longer has; archived marks
      // stay so unarchiving restores the area identity.
      if (live === undefined) return
      for (const sessionId of hostIds) {
        if (live.has(sessionId) || archivedSet.has(sessionId) || typeof remote.clearAppConversation !== 'function') continue
        try { await remote.clearAppConversation(sessionId) } catch { /* best effort */ }
      }
    },

    async select(sessionId: string): Promise<ConversationSession | undefined> {
      const target = remembered().find(candidate => candidate.sessionId === sessionId)
      if (target === undefined) return undefined
      if (archived(sessionId)) return undefined
      try {
        const previous = preferences.getSnapshot().appConversation
        if (previous?.sessionId !== undefined && previous.sessionId !== target.sessionId) await clearHostContext(previous.sessionId)
        const reference = sessions.retain(target.sessionId, { source: 'applicationHarnessConversation', facets: { conversation: true } })
        remember(remembered(), target)
        await markOrThrow(target.sessionId)
        await sendPage()
        return reference
      } catch {
        /* v8 ignore next 2 -- a retained Session disappearing is browser-only */
        clear()
        return undefined
      }
    },

    async create(): Promise<ConversationSession> {
      let active = preferences.getSnapshot().appConversation
      if (active === undefined) throw new Error('application conversation has not been set up')
      if (archived(active.sessionId)) {
        const next = remembered().find(candidate => !archived(candidate.sessionId))
        if (next === undefined) throw new Error('the application conversation is archived; set up a new one')
        remember(remembered(), next)
        active = next
      }
      const sessionId = await sessions.create({ workspaceId: active.workspaceId, agentPreset: 'standard' })
      const target = { workspaceId: active.workspaceId, sessionId }
      if (active.sessionId !== sessionId) await clearHostContext(active.sessionId)
      remember([...remembered(), target], target)
      const reference = sessions.retain(sessionId, { source: 'applicationHarnessConversation', facets: { conversation: true } })
      try {
        await markOrThrow(sessionId)
      } catch (error) {
        drop(sessionId)
        throw error
      }
      await sendPage()
      return reference
    },

    async setPage(page: AppConversationPage | undefined): Promise<void> {
      lastPage = page
      await sendPage()
    },

    async setContextEnabled(enabled: boolean, sessionId?: string): Promise<void> {
      const target = sessionId ?? preferences.getSnapshot().appConversation?.sessionId
      if (target === undefined) return
      contextEnabled.set(target, enabled)
      await sendPage()
    },

    async open(): Promise<ConversationSession | undefined> {
      let target = preferences.getSnapshot().appConversation
      if (target === undefined) return undefined
      if (archived(target.sessionId)) {
        const next = remembered().find(candidate => !archived(candidate.sessionId))
        remember(remembered(), next)
        target = next
        if (target === undefined) return undefined
      }
      try {
        const reference = sessions.retain(target.sessionId, { source: 'applicationHarnessConversation', facets: { conversation: true } })
        await markOrThrow(target.sessionId)
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
      let prepared = trimmed
      if (typeof remote.prepareAppConversationWorkspace === 'function') {
        const result = await remote.prepareAppConversationWorkspace(trimmed)
        if (!result.ok) throw new Error('the application conversation workspace could not be prepared')
        prepared = result.value
      }
      const workspace = await workspaces.create({ path: prepared })
      const sessionId = await sessions.create({ workspaceId: workspace.workspaceId, cwd: workspace.path, agentPreset: 'standard' })
      const target = { workspaceId: workspace.workspaceId, sessionId }
      remember([...remembered(), target], target)
      try {
        const reference = sessions.retain(sessionId, { source: 'applicationHarnessConversation', facets: { conversation: true } })
        await markOrThrow(sessionId)
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
