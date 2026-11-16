/**
 * calendar application page plugin, browser half: registers the `calendar`
 * page into the applications shell's `applicationViews` registry (one view per
 * appId) and the package's `calendar` locale dictionaries.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { CalendarPage } from './CalendarView.tsx'
import { en, NS, type CalendarKey, zh } from './locales.ts'
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Calendar page copy. */
    'calendar': CalendarKey
  }
}

export type { CalendarKey } from './locales.ts'
export { CalendarView } from './CalendarView.tsx'
export type { CalendarViewProps } from './CalendarView.tsx'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

/** The application id this package draws the page of. */
const APP_ID = 'calendar'

/**
 * Client plugin body: register the dictionaries and the calendar page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-calendar: dictionaries')

  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    Component: props => createElement(CalendarPage, { ...props, locale: ctx.locale }),
    contentLayout: 'fill',
  }
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-calendar: page')
}
