// @vitest-environment jsdom
/**
 * The application page's session-scoped conversation seat: the phase decision
 * handed to the platform's shared `conversation.content` factory, and the fixed
 * Chat view it exposes.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import {
  ConversationPanel, FixedChatConversationView, type ConversationPanelProps,
} from '../src/client/ApplicationsConversation.tsx'

function props(overrides: {
  readonly blank?: boolean
  readonly openState?: 'loading' | 'open'
  readonly summaryBlank?: boolean
  readonly renderFactorySlot?: (...args: never[]) => ReactNode
} = {}): ConversationPanelProps {
  const {
    blank = true, openState = 'open', summaryBlank = true, renderFactorySlot = () => <div data-testid="factory" />,
  } = overrides
  const session = {
    blank,
    awaitingFirstTurn: false,
    running: false,
    promptAttempted: false,
    openState,
  }
  return {
    sessionId: 'session-1',
    useSession: (select: (value: typeof session) => unknown) => select(session),
    useConversation: (select: (value: { activeTargets: Set<string> }) => unknown) => select({ activeTargets: new Set() }),
    useSessions: (select: (value: { byId: Record<string, { blank: boolean }> }) => unknown) => select({
      byId: { 'session-1': { blank: summaryBlank } },
    }),
    renderFactorySlot,
  } as unknown as ConversationPanelProps
}

describe('the application conversation seat', () => {
  it('renders the embedded factory in the hero phase for an empty Session', () => {
    const factory = vi.fn(() => <div data-testid="factory" />)
    const view = render(<ConversationPanel {...props({ renderFactorySlot: factory })} />)
    expect(factory).toHaveBeenCalledWith(
      'conversation.content',
      { variant: 'embedded', phase: 'hero', hero: true },
      { slots: { views: FixedChatConversationView } },
    )
    expect(view.getByTestId('factory')).toBeDefined()
  })

  it('renders the active phase for a Session that already has content', () => {
    const factory = vi.fn(() => <div data-testid="factory" />)
    render(<ConversationPanel {...props({ blank: false, summaryBlank: false, renderFactorySlot: factory })} />)
    expect(factory).toHaveBeenCalledWith(
      'conversation.content',
      { variant: 'embedded', phase: 'active', hero: false },
      { slots: { views: FixedChatConversationView } },
    )
  })

  it('settles while a blank Session is still loading', () => {
    const factory = vi.fn(() => <div data-testid="factory" />)
    render(<ConversationPanel {...props({
      blank: true, openState: 'loading', summaryBlank: false, renderFactorySlot: factory,
    })} />)
    expect(factory).toHaveBeenCalledWith(
      'conversation.content',
      { variant: 'embedded', phase: 'settling', hero: false },
      { slots: { views: FixedChatConversationView } },
    )
  })

  it('renders the Chat view through the platform slot', () => {
    const renderSlot = vi.fn(() => <div data-testid="chat" />)
    const view = render(
      <FixedChatConversationView
        {...({ renderSlot } as unknown as Parameters<typeof FixedChatConversationView>[0])}
      />,
    )
    expect(renderSlot).toHaveBeenCalledWith('conversation.session', { view: 'chat' })
    expect(view.getByTestId('chat')).toBeDefined()
  })
})
