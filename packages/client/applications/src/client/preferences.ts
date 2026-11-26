/**
 * The application area's own layout preferences: which application the human
 * was last on and the order of the application tabs. Kept apart from
 * business data, drafts and grants (they belong to the applications and the
 * host), and apart from the per-application view state (that belongs to each
 * application): a lost preference only costs one click, so storage that
 * refuses is not an error the human has to see.
 *
 * Scope: one entry per browser origin, which is one host deployment. A host
 * serves one workspace for its whole life (its cwd), so the deployment's own
 * identity IS the origin here — the platform exposes no current-workspace
 * identity to a session-independent panel, and inventing one from the page
 * path or a random constant would only look like scoping.
 * @module @matrix1001/dsh-application-harness-client-applications/client/preferences
 */

import { createSnapshotStore, type SnapshotStore } from '@matrix1001/dsh-application-harness-client-chrome'

/** The storage key (namespaced + versioned, as the platform's own preferences are). */
export const PREFERENCES_KEY = 'dsh.applications.preferences.v1'

/** What the area remembers across reloads. */
export interface ApplicationPreferences {
  /** The application the human was last on; absent before the first choice. */
  readonly lastAppId?: string | undefined
  /**
   * The page applications fixed to the tab strip, in the human's order.
   * Absent means "all page applications are fixed" (a fresh deployment);
   * `[]` means every page application is in the more-applications menu.
   * Ids that no longer exist are ignored.
   */
  readonly pinned?: readonly string[] | undefined
  /**
   * The application area's dedicated conversation: the Workspace that owns it
   * and the Session the pane shows. Absent before the first-use setup; the
   * ids are a UI mapping, never business data.
   */
  readonly appConversation?: { readonly workspaceId: string; readonly sessionId: string } | undefined
  /** The application-area conversations, in creation order; the active target is above. */
  readonly appConversations?: readonly { readonly workspaceId: string; readonly sessionId: string }[] | undefined
  /** Development Sessions by application; UI mapping only. */
  readonly developmentSessions?: readonly { readonly appId: string; readonly sessionId: string }[] | undefined
  /** Whether the application-area dock is expanded; absent = collapsed. */
  readonly dockExpanded?: boolean | undefined
  /** The dock's remembered width in px. */
  readonly dockWidth?: number | undefined
  /** The Session the dock last showed. */
  readonly dockActive?: string | undefined
  /** Whether the other applications' development tabs are unfolded. */
  readonly dockOtherDevOpen?: boolean | undefined
  /** Normal Sessions opened as dock tabs (the session ids). */
  readonly dockNormalTabs?: readonly string[] | undefined
  /** Session tabs explicitly closed in the dock (the Session remains in its list). */
  readonly dockHidden?: readonly string[] | undefined
}

/**
 * The defaults of a fresh deployment: every page application fixed, host order.
 *
 * A fresh deployment needs no stored list; the saved `pinned` list only starts
 * once the human edits the navigation, and then it also carries the order.
 */
export const PREFERENCE_DEFAULTS: ApplicationPreferences = {}

/**
 * Create the preference store. Persistence rides the platform's snapshot store
 * (localStorage, non-fatal on failure) and is per origin.
 * @returns the store the area binds.
 */
export function createPreferences(): SnapshotStore<ApplicationPreferences> {
  return createSnapshotStore<ApplicationPreferences>(PREFERENCE_DEFAULTS, { persist: { name: PREFERENCES_KEY } })
}
