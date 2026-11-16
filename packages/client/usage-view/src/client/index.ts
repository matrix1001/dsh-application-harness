/**
 * usage application page plugin, browser half: registers the `usage` page
 * into the applications shell's `applicationViews` registry (one view per
 * appId) and the package's `usage` locale dictionaries.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { UsagePage } from './UsageView.tsx'
import { en, NS, type UsageKey, zh } from './locales.ts'
// Type-only: pulls the applications shell's Context merge (`ctx.applicationViews`)
// and the registration contract into this face. The behaviour rides the
// service; this package never value-imports the shell.
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Usage page copy. */
    'usage': UsageKey
  }
}

export type { UsageKey } from './locales.ts'
export { UsagePage, UsageView } from './UsageView.tsx'
export type { UsagePageProps, UsageViewProps } from './UsageView.tsx'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

/** The application id this package draws the page of. */
const APP_ID = 'usage'

/**
 * Client plugin body: register the dictionaries and the usage page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-usage: dictionaries')

  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    Component: props => createElement(UsagePage, { ...props, locale: ctx.locale }),
    contentLayout: 'fill',
  }
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-usage: page')
}
