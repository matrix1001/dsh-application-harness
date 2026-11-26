/**
 * The application page's own right conversation pane content.
 *
 * The application page stays the keyed `main` panel; its registration declares
 * the session child `applications.conversation`, and the area wraps the child in
 * the standard `SessionProvider` with the main Session's retained reference.
 * This module owns only the child: it renders the platform's shared
 * `conversation.content` factory (transcript + composer + approvals), never a
 * second composer implementation.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ApplicationsConversation
 */
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps, WorkspaceSelectedHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ReactNode } from 'react'

/** The business face injected into the application page's Conversation seat. */
export interface ApplicationsConversationInjected {
  /** Handle a Workspace picked in the embedded hero through the platform navigation. */
  openWorkspace: WorkspaceSelectedHandler
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Session-scoped Conversation hosted by the application page's right pane. */
    'applications.conversation': {
      kind: 'single'
      scope: 'session'
      inject: ApplicationsConversationInjected
    }
  }
}

/** The fixed Chat view inside the embedded Conversation content. */
export function FixedChatConversationView(props: ConversationViewsProps): ReactNode {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props supplied to the application page's session-scoped conversation seat. */
export type ConversationPanelProps = PropsRuntime<'applications.conversation'> & PropsRenderFactories

/**
 * Render the shared Conversation content for the retained main Session.
 * @param props - the session-scoped runtime hooks and the factory renderer.
 * @returns the embedded Conversation content.
 */
export function ConversationPanel({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot, openWorkspace,
}: ConversationPanelProps): ReactNode {
  const session = useSession(value => value)
  // Embedders and the slot test runtime may render this seat without the
  // conversation hook; the panel then has no targets yet, which is the same
  // state as a blank Session.
  const conversation = typeof useConversation === 'function'
    ? useConversation(value => value)
    : { activeTargets: new Set<string>() }
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', {
    variant: 'embedded', phase, hero, onWorkspaceSelected: openWorkspace,
  }, {
    slots: { views: FixedChatConversationView },
  })
}
