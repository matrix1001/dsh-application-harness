/**
 * tasks application page plugin, browser half: registers the `tasks` page
 * into the applications shell's `applicationViews` registry (one view per
 * appId) and the package's `tasks` locale dictionaries.
 *
 * The registration is the whole wiring: the framework hands the page its
 * `ApplicationViewProps` (call/cancel/onChanged/running, the page-context face
 * and this application's own `ui` view state), and this package's page reads
 * the application through that one face — no projection, no world slot. An
 * application with real settings registers a `Settings` half beside
 * `Component`; one without it simply omits the field.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { TasksPage } from './TasksView.tsx'
import { en, NS, type TasksKey, zh } from './locales.ts'
// Type-only: pulls the applications shell's Context merge (`ctx.applicationViews`)
// and the registration contract into this face. The behaviour rides the
// service; this package never value-imports the shell.
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tasks page copy. */
    'tasks': TasksKey
  }
}

export type { TasksKey } from './locales.ts'
export { TasksView } from './TasksView.tsx'
export type { TasksViewProps } from './TasksView.tsx'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

/** The application id this package draws the page of. */
const APP_ID = 'tasks'

/**
 * Client plugin body: register the dictionaries and the tasks page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-tasks: dictionaries')

  // The name and the description are getters over the dictionary: the
  // registration runs once, a language switch happens later, and the shell
  // reads them per render. An application with its own glyph declares `icon`
  // (and a semantic `tone`) beside them.
  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    Component: props => createElement(TasksPage, { ...props, locale: ctx.locale }),
    contentLayout: 'fill',
  }
  // Fiber-owned: the page unregisters with the plugin (HMR safety), and the
  // registry itself rejects a second view for the same appId (a silent
  // override would hide a package conflict).
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-tasks: page')
}
