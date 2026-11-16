/**
 * The application area's own layout preferences: which application the human
 * was last on, and whether the navigation column is expanded. Kept apart from
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

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The storage key (namespaced + versioned, as the platform's own preferences are). */
export const PREFERENCES_KEY = 'dsh.applications.preferences.v1'

/** What the area remembers across reloads. */
export interface ApplicationPreferences {
  /** The application the human was last on; absent before the first choice. */
  readonly lastAppId?: string | undefined
  /** Whether the desktop navigation column is expanded. */
  readonly navExpanded: boolean
  /**
   * The human's own order of the page applications (host ids). Empty means the
   * host registration order; ids that no longer exist are ignored, and an
   * application the list does not name is appended in host order.
   */
  readonly navOrder: readonly string[]
  /**
   * The application area's dedicated conversation: the Workspace that owns it
   * and the Session the pane shows. Absent before the first-use setup; the
   * ids are a UI mapping, never business data.
   */
  readonly appConversation?: { readonly workspaceId: string; readonly sessionId: string } | undefined
}

/**
 * The defaults of a fresh deployment: navigation expanded, host order.
 *
 * The platform sidebar exposes one 应用 entry, not the eight application rows;
 * entering the area with the column folded left the user with a single app and
 * no visible way to discover the rest. The area is one click wide, and the
 * narrow drawer still exists, so expanding on first entry is the discoverable
 * default; a human who prefers it folded keeps that preference.
 */
export const PREFERENCE_DEFAULTS: ApplicationPreferences = { navExpanded: true, navOrder: [] }

/**
 * Create the preference store. Persistence rides the platform's snapshot store
 * (localStorage, non-fatal on failure) and is per origin.
 * @returns the store the area binds.
 */
export function createPreferences(): SnapshotStore<ApplicationPreferences> {
  return createSnapshotStore<ApplicationPreferences>(PREFERENCE_DEFAULTS, { persist: { name: PREFERENCES_KEY } })
}
