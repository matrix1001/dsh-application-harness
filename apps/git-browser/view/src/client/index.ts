/**
 * Git-browser view plugin, browser half: registers the `git-browser` page into
 * the applications shell's `applicationViews` registry (one view per appId) and
 * the package's `git-browser` locale dictionaries.
 *
 * The registration is the whole wiring: the shell hands the view its
 * `ApplicationViewProps` (`call`/`cancel`/`onChanged`/`running`/`pageContext`/
 * `ui`) and this package's page reads the four read-only operations through
 * that one face. The locale service is bound at the registration site (the
 * shell's view props carry no translator), and the page re-renders on a locale
 * switch through the service's own subscription.
 */
import { createElement } from 'react'
import { IconBranchOutlineRegular } from '@matrix1001/dsh-application-harness-client-chrome'
import type { Context } from '@deepseek-ai/cordis'
import { GitBrowserPage } from './GitBrowserView.tsx'
import { en, NS, type GitBrowserKey, zh } from './locales.ts'
// Type-only: pulls the applications shell's Context merge (`ctx.applicationViews`)
// and the registration contract into this face. The behaviour rides the
// service; this package never value-imports the shell.
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git-browser workbench copy. */
    'git-browser': GitBrowserKey
  }
}

// The entry exports only cordis loading needs (apply/inject) plus the shared
// locale type: the implementation component stays internal — a cross-package
// spec imports it through the `./src/*` subpath, never by widening the public
// API (export discipline).
export type { GitBrowserKey } from './locales.ts'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

/** The application id this package draws the page of. */
const APP_ID = 'git-browser'

/**
 * Client plugin body: register the dictionaries and the git-browser page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-git-browser: dictionaries')

  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    icon: ({ size }) => createElement(IconBranchOutlineRegular, { size }),
    tone: 'neutral',
    // A bounded workbench: the group lists and the patch panel own their scroll.
    contentLayout: 'fill',
    Component: props => createElement(GitBrowserPage, { ...props, locale: ctx.locale }),
  }
  // Fiber-owned: the page unregisters with the plugin (HMR safety), and the
  // registry itself rejects a second view for the same appId (a silent
  // override would hide a package conflict).
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-git-browser: page')
}
