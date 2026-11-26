/**
 * DSH conversation header action: bring the current Session into the
 * application area's Session dock. The same Session is retained there; this
 * action only selects the panel and asks the dock to show it.
 * @module @matrix1001/dsh-application-harness-client-applications/client/OpenInAreaAction
 */
import type { ReactNode } from 'react'
import { Button, IconAppsAddOutlineRegular } from '@matrix1001/dsh-application-harness-client-chrome'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DockService, DockTabKind } from './dock.ts'

/** What the action needs from the framework instance. */
export interface OpenInAreaActionProps {
  readonly sessionId: string
  readonly kind: DockTabKind
  readonly appId?: string
  readonly dock: DockService
  readonly selectPanel: () => void
  readonly label: string
}

/**
 * Render the header action.
 * @param props - the session, its dock kind, the one-shot request and the panel selector.
 * @returns the action button.
 */
export function OpenInAreaAction({ sessionId, kind, appId, dock, selectPanel, label }: OpenInAreaActionProps): ReactNode {
  return (
    <Button
      size="sm"
      variant="ghost"
      data-open-in-area={sessionId}
      aria-label={label}
      title={label}
      onClick={() => {
        dock.open({ sessionId, kind, ...(appId === undefined ? {} : { appId }) })
        selectPanel()
      }}
    >
      <IconAppsAddOutlineRegular size={14} />
    </Button>
  )
}

/** The props the platform passes to the header action seat. */
export type HeaderActionProps = PropsRuntime<'conversation.session.header.actions'>
