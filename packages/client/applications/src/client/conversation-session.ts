/**
 * The application page's right conversation pane retains the Session it shows.
 *
 * The application page owns the keyed `main` panel, so the platform's
 * Conversation view is not mounted while it is showing; the pane therefore
 * takes an independent reference to its own application-area Session and
 * releases it when the pane closes. The type here is the small structural face
 * the pane needs: the platform reference is the real object, and the
 * `SessionProvider` seat receives it unchanged.
 * @module @matrix1001/dsh-application-harness-client-applications/client/conversation-session
 */

/** The retained Session reference the pane holds until it closes. */
export interface ConversationSession {
  /** Release this pane's reference once. */
  release(): void
}
