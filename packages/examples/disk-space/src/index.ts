/**
 * The disk-space application's Cordis row: one row, one application, one
 * application-owned SQLite index. The database defaults to the harness home
 * (`dshHomePath('application-harness/disk-space/index.db')`); a deployment may pass an
 * explicit path through the row config, and the old `disk-analysis` index is
 * never read, converted or reused.
 * @module @matrix1001/dsh-application-harness-disk-space
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { diskSpaceDeclaration } from './app.ts'
import { DiskSpaceService } from './service.ts'

/** The `disk-space` row's config. */
export interface DiskSpaceConfig {
  /**
   * The application's SQLite index. Absent = the harness home default
   * (`application-harness/disk-space/index.db`).
   */
  databasePath?: string
}

/** The plugin name (the row id in a composition). */
export const name = 'application-harness-disk-space'

/** The row config schema (validated before the plugin starts: fail loud). */
export const Config = Schema.object({
  databasePath: Schema.string(),
})

/** The services the row cannot work without: the runtime registry it registers into. */
export const inject = ['applications']

/**
 * Mount the application: register the declaration, open the index and close it
 * when the row unloads.
 * @param ctx - the Cordis context (with the runtime injected).
 * @param config - the validated row config.
 */
export async function apply(ctx: Context, config: DiskSpaceConfig = {}): Promise<void> {
  const service = new DiskSpaceService(config.databasePath ?? dshHomePath('application-harness/disk-space/index.db'))
  ctx.effect(() => () => { service.close() })
  await mountApplication(ctx, diskSpaceDeclaration(service))
}

export { DISK_SPACE_APP_ID, DISK_SPACE_SCHEMA_VERSION, diskSpaceDeclaration } from './app.ts'
export { DiskSpaceService } from './service.ts'
export type { ServiceIo, ServiceOptions } from './service.ts'
export { DiskStore, SCHEMA_VERSION } from './store.ts'
export type { CreateScanInput, EntryRecord, TrashRow } from './store.ts'
export type {
  BrowseEntry, BrowsePage, CancelScanResult, DuplicateCandidate, DuplicateGroup, DuplicateListResult,
  DuplicateState, DuplicateSummary, LargeFilesResult, ListScansResult, ListTrashResult, PurgeTrashResult,
  ReadScanResult, RestoreTrashResult, ScanError, ScanProgress, ScanRecord, ScanResult, ScanState,
  StageEntriesResult, TrashEntry,
} from './types.ts'
