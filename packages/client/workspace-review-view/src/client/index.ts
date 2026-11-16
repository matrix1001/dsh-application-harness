/**
 * workspace-review view plugin, browser half: registers the `workspace-review`
 * page into the applications shell's `applicationViews` registry and the
 * package's `workspace-review` locale dictionaries.
 *
 * The registration is the whole wiring: the shell hands the page its
 * `ApplicationViewProps`; this page reads every operation through that one
 * face and never talks to the Remote service itself.
 * @module @matrix1001/dsh-application-harness-workspace-review-view/client
 */

import { createElement } from 'react'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceReviewPage } from './WorkspaceReviewView.tsx'
import { WorkspaceReviewSettings } from './Settings.tsx'
import { en, NS, type WorkspaceReviewKey, zh } from './locales.ts'
// Type-only: pulls the applications shell's Context merge and registration
// contract into this face. The behaviour rides the service.
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace-review page copy. */
    'workspace-review': WorkspaceReviewKey
  }
}

export type { WorkspaceReviewKey } from './locales.ts'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

/** The application id this package draws the page of. */
const APP_ID = 'workspace-review'

/**
 * Client plugin body: register the dictionaries and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-review: dictionaries')

  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    icon: ({ size }) => createElement(IconClockOutlineRegular, { size }),
    tone: 'business',
    contentLayout: 'fill',
    Component: props => createElement(WorkspaceReviewPage, { ...props, locale: ctx.locale }),
    Settings: props => createElement(WorkspaceReviewSettings, { ...props, t }),
  }
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-workspace-review: page')
}
