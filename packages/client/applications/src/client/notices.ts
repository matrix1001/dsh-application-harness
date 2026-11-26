/**
 * One shell-level notice the application area's header status control reports:
 * the connection going away, a failed shell command, an application the host
 * cannot use right now, a permission refusal, or a running call's progress.
 * The notice owns its actions so the header never has to know what each one
 * means.
 * @module @matrix1001/dsh-application-harness-client-applications/client/notices
 */

/** One action attached to a shell notice. */
export interface AreaNoticeAction {
  /** The visible label (the caller's dictionary). */
  readonly label: string
  /** What the action does. */
  readonly onClick: () => void
  /** Optional stable data anchors for the acceptance lane. */
  readonly anchor?: Readonly<Record<string, string>> | undefined
}

/** One shell-level notice. */
export interface AreaNotice {
  /** Stable identity (two notices never share it). */
  readonly id: string
  /** Severity, which chooses the status edge and the live-region role. */
  readonly tone: 'error' | 'warning' | 'info'
  /** The text to read (already localized). */
  readonly text: string
  /** Optional inline actions. */
  readonly actions?: readonly AreaNoticeAction[] | undefined
  /** Optional stable data anchors forwarded to the notice element. */
  readonly anchor?: Readonly<Record<string, string>> | undefined
  /** Optional raw diagnostic text, shown only inside the status panel's disclosure. */
  readonly detail?: string | undefined
}
