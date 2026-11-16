/**
 * inbox application page plugin, browser half: registers the `inbox` page into
 * the applications shell's `applicationViews` registry and the package's locale
 * dictionaries.
 * @module @matrix1001/dsh-application-harness-inbox-view/client
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { InboxPage } from './InboxView.tsx'
import { en, NS, zh } from './locales.ts'
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

export type { InboxKey } from './locales.ts'
export { InboxPage, InboxView } from './InboxView.tsx'
export type { InboxPageProps, InboxViewProps } from './InboxView.tsx'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

const APP_ID = 'inbox'

/**
 * Client plugin body: register the dictionaries and the inbox page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-inbox: dictionaries')
  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    Component: props => createElement(InboxPage, { ...props, locale: ctx.locale }),
    contentLayout: 'fill',
  }
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-inbox: page')
}
