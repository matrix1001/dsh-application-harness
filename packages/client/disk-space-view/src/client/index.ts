/**
 * Disk-space view plugin, browser half: registers the `disk-space` page into
 * the applications shell's `applicationViews` registry (one view per appId)
 * and this package's locale dictionaries.
 *
 * The page gets exactly the shell's `ApplicationViewProps` plus this package's
 * translator and a directory-picker closure. The picker namespace is resolved
 * PER ACTION: the platform registers it when the client connection becomes
 * ready, so caching the first `undefined` would hide the affordance forever.
 * When the namespace or its `pick` verb is absent (or the call fails) the
 * closure returns `undefined`; the page then keeps the path input as the only
 * route instead of inventing a path.
 */
import { createElement } from 'react'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import { DiskSpacePage, type DiskSpaceTranslate } from './DiskSpaceView.tsx'
import { en, NS, type DiskSpaceKey, zh } from './locales.ts'
// Type-only: pulls the applications shell's Context merge (`ctx.applicationViews`)
// and the registration contract into this face. The behaviour rides the
// service; this package never value-imports the shell.
import type {} from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Disk-space view copy. */
    'disk-space': DiskSpaceKey
  }
}

// The entry exports only cordis loading needs (apply/inject), the picker
// adapter (its own unit test reads it) and the shared locale type.
export type { DiskSpaceKey } from './locales.ts'

/** Required services: the locale dictionaries and the applications shell's view registry. */
export const inject = ['locale', 'applicationViews']

/** The application id this package draws the page of. */
const APP_ID = 'disk-space'

/** The structural face of the platform's directory-picker remote. */
export interface DirectoryPickerRemote {
  /** Ask the host for one absolute directory (`null` = user cancel). */
  pick: () => Promise<{ ok: boolean; value?: string | null; error?: { code?: string; message?: string } }>
}

/**
 * Resolve the directory-picker remote for ONE action.
 * @param ctx - the client root context.
 * @returns the remote when this deployment serves the `pick` verb.
 */
export function directoryPicker(ctx: Context): DirectoryPickerRemote | undefined {
  const remote = ctx.get('remote.directoryPicker') as Partial<DirectoryPickerRemote> | undefined
  if (remote === undefined || typeof remote.pick !== 'function') return undefined
  return remote as DirectoryPickerRemote
}

/**
 * Ask the host for one directory, degrading to the path input on every
 * absence, cancel and failure.
 * @param ctx - the client root context.
 * @returns the picked absolute path, or undefined when there is none to use.
 */
export async function pickDirectory(ctx: Context): Promise<string | undefined> {
  const remote = directoryPicker(ctx)
  if (remote === undefined) return undefined
  try {
    const result = await remote.pick()
    return result.ok && typeof result.value === 'string' ? result.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Client plugin body: register the dictionaries and the disk-space page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-disk-space: dictionaries')

  const t = ctx.locale.bind(NS)
  const view: ApplicationView = {
    name: () => t('app.name'),
    description: () => t('app.description'),
    icon: ({ size }) => createElement(IconDatabaseOutlineRegular, { size }),
    tone: 'warn',
    contentLayout: 'fill',
    Component: props => createElement(DiskSpacePage, {
      ...props,
      locale: ctx.locale,
      pickDirectory: async () => await pickDirectory(ctx),
    }),
  }
  // Fiber-owned: the page unregisters with the plugin (HMR safety), and the
  // registry itself rejects a second view for the same appId.
  ctx.effect(() => ctx.applicationViews.register(APP_ID, view), 'ui-disk-space: page')
}

/** The translate type the registered page binds (exported for the view's tests). */
export type { DiskSpaceTranslate }
