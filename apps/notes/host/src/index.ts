/**
 * The notes Cordis plugin: one row, one application, one gated SQLite
 * namespace and one application-owned attachment directory. The repository is
 * constructed here and its capability door is attached in the application's
 * start hook.
 *
 * The row config binds the attachment byte directory
 * (`dshHomePath('application-harness/notes/attachments')` in the deployed
 * bundle). A composition that omits the config — the keyless examples mount
 * the row bare — falls back to the same harness-home location, so attachment
 * behaviour never depends on how the application was mounted; the directory is
 * still created lazily on the first write.
 * @module @matrix1001/dsh-application-harness-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { createPlatformModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import type { GatedStore } from '@matrix1001/dsh-application-harness-store'
import { NotesDeclaration, NotesRepository } from './app.ts'
import { AttachmentStore } from './attachments.ts'

/** The plugin name. */
export const name = 'notes'

/** Required runtime and storage services. */
export const inject = ['applications', 'applicationStore']

/** The `notes` row's config. */
export interface NotesConfig {
  /**
   * The application-owned directory attachment bytes live in. The deployed
   * bundle binds it (and declares it in the deployment `homeFiles`); an
   * absent config falls back to the same harness-home location.
   */
  attachmentsPath?: string
}

/** The row config schema (validated before the plugin starts: fail loud). */
export const Config = Schema.object({
  attachmentsPath: Schema.string(),
})

/**
 * Mount the application.
 * @param ctx - the Cordis context (with the runtime and store services injected).
 * @param config - the validated row config.
 * @returns when the application is mounted.
 */
export async function apply(ctx: Context, config: NotesConfig = {}): Promise<void> {
  const attachments = new AttachmentStore(config.attachmentsPath ?? dshHomePath('application-harness/notes/attachments'))
  await mountApplication<GatedStore>(ctx, (store) => {
    const repository = new NotesRepository(store('notes'), attachments, createPlatformModelPort(ctx, 'notes'))
    return NotesDeclaration(repository)
  })
}

export { NotesDeclaration, NotesRepository } from './app.ts'
export { AttachmentStore, MAX_ATTACHMENT_BYTES, MAX_EXPORT_ATTACHMENT_BYTES, MAX_NOTE_ATTACHMENT_BYTES } from './attachments.ts'
export type {
  AttachmentDeleteResult,
  AttachmentDownload,
  AttachmentUploadResult,
  AttachmentView,
  ExportedNotesDocument,
  Note,
  NoteSummary,
  NotesDocument,
  NotesExportResult,
  NotesImportResult,
} from './app.ts'
export type { AttachmentUpload, DecodedAttachment, NoteAttachment } from './attachments.ts'
