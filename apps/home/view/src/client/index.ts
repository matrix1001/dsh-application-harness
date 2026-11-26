/**
 * home page plugin, browser half: registers the `home` page into the
 * applications shell's `applicationViews` registry and the package's `home`
 * locale dictionaries.
 * @module @matrix1001/dsh-application-harness-home-view/client
 */
import { createElement } from 'react'
import { IconGaugeOutlineRegular } from '@matrix1001/dsh-application-harness-client-chrome'
import type { Context } from '@deepseek-ai/cordis'
import { HomePage } from './HomeView.tsx'
import { en, NS, zh } from './locales.ts'
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

export type { HomeKey } from './locales.ts'
export { HomePage, HomeView } from './HomeView.tsx'
export type { HomePageProps, HomeViewProps } from './HomeView.tsx'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

const APP_ID = 'home'

/**
 * Client plugin body: register the dictionaries and the home page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-home: dictionaries')
  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    icon: ({ size }) => createElement(IconGaugeOutlineRegular, { size }),
    tone: 'neutral',
    Component: props => createElement(HomePage, { ...props, locale: ctx.locale }),
    // The dashboard is a document that may scroll; the shell owns the scroller.
    contentLayout: 'flow',
  }
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-home: page')
}
