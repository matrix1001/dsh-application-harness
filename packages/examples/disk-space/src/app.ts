/**
 * The disk-space application declaration. The ops are thin delegates over
 * {@link DiskSpaceService}; the declaration is the one place that states what
 * a caller sees (description, parameters, result, openness), the durable data
 * declaration and the platform capabilities the application needs.
 * @module
 */

import type { AppDeclaration, OperationContext, OperationDeclaration, ParameterSchemaSpec, ValueSchemaSpec } from '@matrix1001/dsh-application-harness-runtime'
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'
import type { DiskSpaceService } from './service.ts'

/** The application id. */
export const DISK_SPACE_APP_ID = 'disk-space'

/** The durable schema version the declaration promises. */
export const DISK_SPACE_SCHEMA_VERSION = 1

/** One declaration parameter. */
const str = (description: string, required = false): ParameterPropertySpec =>
  required
    ? { type: 'string', description, required: true }
    : { type: 'string', description }

/** One optional integer parameter. */
const int = (description: string): ParameterPropertySpec => ({ type: 'integer', description })

/** One boolean parameter. */
const bool = (description: string): ParameterPropertySpec => ({ type: 'boolean', description })

/** One string-array parameter. */
const strings = (description: string, required = false): ParameterPropertySpec =>
  required
    ? { type: 'array', items: { type: 'string' }, description, required: true }
    : { type: 'array', items: { type: 'string' }, description }

/** The common JSON result description. */
const jsonResult = (description: string): ValueSchemaSpec => ({ type: 'json', description })

/** Build one read-only operation. */
function read(description: string, params: ParameterSchemaSpec, execute: (args: unknown) => unknown): OperationDeclaration {
  return {
    description,
    params,
    result: jsonResult('The read result'),
    effect: 'read',
    exposure: { ai: 'open', peers: 'open' },
    execute: args => execute(args) as never,
  }
}

/** Build one mutating operation. */
function write(description: string, params: ParameterSchemaSpec, execute: (args: unknown, ctx: OperationContext) => unknown, closed = false): OperationDeclaration {
  return {
    description,
    params,
    result: jsonResult('The write result'),
    effect: 'write',
    exposure: closed ? { ai: 'closed', peers: 'closed' } : { ai: 'confirm', peers: 'open' },
    execute: (args, ctx) => execute(args, ctx) as never,
  }
}

/**
 * Build the disk-space declaration over one service.
 * @param service - the opened application service.
 * @returns the declaration the runtime registers.
 */
export function diskSpaceDeclaration(service: DiskSpaceService): AppDeclaration {
  return {
    id: DISK_SPACE_APP_ID,
    name: '磁盘空间',
    description: '扫描目录、查看空间组成、查找重复文件，并用可恢复的回收站释放空间。',
    version: '0.2.0-rc.1',
    generation: 2,
    data: {
      kind: 'own-sqlite',
      path: 'disk-space/index.db',
      schemaVersion: DISK_SPACE_SCHEMA_VERSION,
      backup: 'exclude',
    },
    capabilities: ['storage'],
    ops: {
      startScan: write(
        'Start a background scan of one absolute directory; only one scan/duplicate analysis runs at a time',
        { dir: str('The absolute directory to scan', true), excludes: strings('Root-relative paths to exclude'), crossFileSystems: bool('Whether the walk may cross filesystems') },
        (args, ctx) => service.startScan(args, ctx),
      ),
      readScan: read(
        'Read one scan, or the newest scan when scanId is omitted; a scan carries state, progress, totals, exclusions and any failure',
        { scanId: str('The scan id (omitted = newest)') },
        args => service.readScan(args),
      ),
      cancelScan: write(
        'Ask the running scan or duplicate analysis to stop; a settled scan is returned with cancelled=false',
        { scanId: str('The scan id (omitted = the active scan)') },
        args => service.cancelScan(args),
      ),
      listScans: read(
        'List the scan history, newest first',
        { limit: int('The maximum number of rows (default 20, max 100)') },
        args => service.listScans(args),
      ),
      browseDirectory: read(
        'List one indexed directory\'s direct children by root-relative path (empty = the scan root)',
        { scanId: str('The scan id', true), path: str('The root-relative directory (empty = root)'), offset: int('The 0-based entry offset'), limit: int('The page size (default 100, max 500)') },
        args => service.browseDirectory(args),
      ),
      listLargeFiles: read(
        'List the indexed files by size, largest first',
        { scanId: str('The scan id', true), limit: int('The number of files (default 100, max 500)') },
        args => service.listLargeFiles(args),
      ),
      startDuplicateAnalysis: write(
        'Start duplicate-file analysis over one completed scan: only same-size files are hashed, and unreadable files are skipped',
        { scanId: str('The completed scan id', true), minSize: int('Only files strictly larger than this many bytes') },
        (args, ctx) => service.startDuplicateAnalysis(args, ctx),
      ),
      listDuplicateGroups: read(
        'List one scan\'s duplicate groups, wasted bytes descending',
        { scanId: str('The scan id', true), offset: int('The 0-based group offset'), limit: int('The page size (default 50, max 500)') },
        args => service.listDuplicateGroups(args),
      ),
      stageEntries: write(
        'Move selected root-relative paths into the scan root\'s reversible trash; every source is validated before any move',
        { scanId: str('The scan id', true), paths: strings('The root-relative paths to stage', true) },
        (args, ctx) => service.stageEntries(args, ctx),
      ),
      listTrash: read(
        'List the reversible trash, newest first',
        {},
        args => service.listTrash(args),
      ),
      restoreTrash: write(
        'Restore one trashed entry to its original path; an existing destination is never replaced',
        { id: str('The trash entry id', true) },
        (args, ctx) => service.restoreTrash(args, ctx),
      ),
      purgeTrash: write(
        'Permanently delete one trashed entry',
        { id: str('The trash entry id', true) },
        (args, ctx) => service.purgeTrash(args, ctx),
        true,
      ),
    },
  }
}
