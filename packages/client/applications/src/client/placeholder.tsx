/**
 * The application area's composer guidance: the built-in editor's placeholder
 * for an application-area or development Session, selected by Session id.
 *
 * The conversation package owns the editor and renders this chain inline; the
 * entry contributes text only, so it never becomes a second placeholder layer.
 * @module @matrix1001/dsh-application-harness-client-applications/client/placeholder
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the conversation's input-placeholder SlotMap row (the owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** What the selector elects for the built-in editor to show. */
export interface ApplicationsPlaceholderMatch {
  readonly text: string
}

/**
 * Render the elected guidance text.
 * @param props - the chain's matched share.
 * @returns the inline text.
 */
export function ApplicationsPlaceholder({
  matched,
}: PropsRuntime<'conversation.input.placeholder'> & { readonly matched: ApplicationsPlaceholderMatch }): ReactNode {
  return <>{matched.text}</>
}
