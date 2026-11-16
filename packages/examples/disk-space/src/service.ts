/**
 * The disk-space application's business layer: scan/duplicate background work
 * with single-flight and cancellation, the browse readers, and the reversible
 * trash. The operation declarations in `app.ts` are thin delegates over this
 * class, so the same rules apply to the page, the AI face and a peer call.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { objectArgs, optionalBoolean, optionalInteger, optionalString, optionalStringArray, optionalText, requiredString, requiredStringArray } from './args.ts'
import { findDuplicates, nodeDuplicateIo, type DuplicateIo } from './duplicates.ts'
import { abortError, isAbortError, messageOf } from './errors.ts'
import {
  isInsideTrash, normalizeRelativePath, resolveInside, TRASH_DIR,
} from './paths.ts'
import { nodeScanIo, walkDirectory, type ScanIo } from './scanner.ts'
import { DiskStore, type EntryRecord } from './store.ts'
import type {
  BrowsePage, CancelScanResult, DuplicateListResult, DuplicateSummary, LargeFilesResult,
  ListScansResult, ListTrashResult, PurgeTrashResult, ReadScanResult, RestoreTrashResult, ScanProgress,
  ScanRecord, ScanResult, StageEntriesResult, TrashEntry,
} from './types.ts'

/** The empty progress snapshot. */
function zeroProgress(): ScanProgress {
  return { files: 0, dirs: 0, bytes: 0, skipped: 0, currentPath: null }
}

/** Keep this many newest scan indexes (trash-backed scans are retained). */
const SCAN_RETENTION = 5

/** The active background run (one at a time). */
interface ActiveRun {
  /** The scan the run belongs to. */
  scanId: string
  /** Scan walk or duplicate analysis. */
  kind: 'scan' | 'duplicates'
  /** The application-owned cancellation controller. */
  controller: AbortController
}

/** The row's injected seams (tests replace the filesystem/hash sides). */
export interface ServiceIo {
  /** The walk seam. */
  scan: ScanIo
  /** The hashing seam. */
  duplicates: DuplicateIo
}

/** The service's optional seams. */
export interface ServiceOptions {
  /** Filesystem/hash overrides; production uses the node implementations. */
  io?: Partial<ServiceIo>
}

/**
 * Resolve one requested root to its canonical absolute form and prove it is a
 * directory.
 * @param dir - the caller's path.
 * @returns the canonical root.
 * @throws AppError when the path does not exist, is not readable or is not a directory.
 */
async function canonicalRoot(dir: string): Promise<string> {
  let root: string
  try {
    root = await realpath(dir)
  } catch {
    throw new AppError('invalid-root', `disk-space: ${dir} does not exist or is not readable`)
  }
  const stat = await lstat(root)
  if (!stat.isDirectory()) throw new AppError('invalid-root', `disk-space: ${dir} is not a directory`)
  return root
}

/** Whether one path exists (a restore destination is the only caller). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The disk-space application: one SQLite index, one heavy run at a time, and
 * the operations' page readers.
 */
export class DiskSpaceService {
  /** The durable index. */
  readonly store: DiskStore
  /** The production/injected walk seam. */
  private readonly scanIo: ScanIo
  /** The production/injected hashing seam. */
  private readonly duplicateIo: DuplicateIo
  /** The one active background run, when there is one. */
  private active: ActiveRun | null = null

  /**
   * Open the index and bind the seams.
   * @param databasePath - the SQLite file (`:memory:` in tests that do not restart).
   * @param options - optional filesystem/hash overrides.
   */
  constructor(databasePath: string, options: ServiceOptions = {}) {
    this.store = new DiskStore(databasePath)
    this.scanIo = options.io?.scan ?? nodeScanIo
    this.duplicateIo = options.io?.duplicates ?? nodeDuplicateIo
  }

  /** Close the index. */
  close(): void {
    this.store.close()
  }

  /**
   * Tie one background task's cancellation signal to the application's own
   * controller.
   * @param taskSignal - the runtime task's signal.
   * @param controller - the application-owned controller.
   * @returns the listener cleanup.
   */
  private linkAbort(taskSignal: AbortSignal, controller: AbortController): () => void {
    const onAbort = (): void => { controller.abort() }
    if (taskSignal.aborted) controller.abort()
    else taskSignal.addEventListener('abort', onAbort, { once: true })
    return () => { taskSignal.removeEventListener('abort', onAbort) }
  }

  /**
   * Start one scan. The durable row exists before the call returns; the walk
   * itself is application-owned background work.
   * @param raw - the operation arguments.
   * @param ctx - the call context (its `startTask` owns the background work).
   * @returns the scan row as it stands when the call returns.
   */
  async startScan(raw: unknown, ctx: OperationContext): Promise<ScanResult> {
    const args = objectArgs(raw)
    const dir = requiredString(args, 'dir')
    const excludes = optionalStringArray(args, 'excludes').map(normalizeRelativePath)
    const crossFileSystems = optionalBoolean(args, 'crossFileSystems', false)
    if (this.active !== null) throw new AppError('busy', 'disk-space: another scan or duplicate analysis is running')
    const root = await canonicalRoot(dir)
    const scanId = `s_${randomUUID()}`
    const startedAt = Date.now()
    const progress = zeroProgress()
    this.store.createScan({ scanId, root, excludes, crossFileSystems, startedAt, progress })
    const controller = new AbortController()
    this.active = { scanId, kind: 'scan', controller }
    let last = progress

    ctx.startTask({ kind: 'scan', title: `disk-space scan ${root}`, externalId: scanId }, async taskCtx => {
      const unlink = this.linkAbort(taskCtx.signal, controller)
      // Let the caller read the freshly created row before the walk can
      // finish; the one-macrotask deferral also makes cancellation immediate
      // and deterministic instead of racing a tiny tree.
      await new Promise<void>(resolve => { setImmediate(resolve) })
      try {
        if (controller.signal.aborted) throw abortError()
        const walk = await walkDirectory({
          root,
          excludes: [...new Set([...excludes, TRASH_DIR])],
          crossFileSystems,
          signal: controller.signal,
          onProgress: snapshot => {
            last = snapshot
            this.store.updateProgress(scanId, snapshot)
            taskCtx.reportProgress(`walking ${String(snapshot.currentPath)}`, { ...snapshot })
          },
        }, this.scanIo)
        /* v8 ignore next -- the walk throws as soon as it observes the abort; this guards the return window */
        if (controller.signal.aborted) throw abortError()
        last = walk.progress
        const totals = { files: walk.files, dirs: walk.dirs, bytes: walk.bytes }
        this.store.insertEntries(scanId, walk.entries as EntryRecord[])
        this.store.finishScan(scanId, 'completed', walk.progress, totals, null)
        /* v8 ignore next -- index retention is best-effort housekeeping after a successful scan */
        try { this.store.pruneScans(SCAN_RETENTION) } catch { /* the scan itself is complete */ }
        taskCtx.notifyChanged()
        return { scanId, files: walk.files, dirs: walk.dirs, bytes: walk.bytes }
      } catch (error) {
        const totals = { files: last.files, dirs: last.dirs, bytes: last.bytes }
        if (isAbortError(error) || controller.signal.aborted) {
          this.store.finishScan(scanId, 'cancelled', last, totals, null)
          taskCtx.notifyChanged()
          throw abortError()
        }
        const failure = error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: 'scan-failed', message: messageOf(error) }
        this.store.finishScan(scanId, 'failed', last, totals, failure)
        taskCtx.notifyChanged()
        throw error
      } finally {
        unlink()
        this.active = null
      }
    })

    return { scan: this.store.readScan(scanId)!, scanId }
  }

  /**
   * Read one scan, or the newest scan when no id is given.
   * @param raw - the operation arguments.
   * @returns the scan, or `null` when nothing was ever scanned.
   */
  readScan(raw: unknown): ReadScanResult {
    const args = objectArgs(raw)
    const scanId = optionalString(args, 'scanId')
    if (scanId === undefined) return { scan: this.store.latestScan() }
    const scan = this.store.readScan(scanId)
    if (scan === null) throw new AppError('not-found', `disk-space: no scan ${scanId}`)
    return { scan }
  }

  /**
   * Ask the running scan/duplicate analysis to stop. A settled scan is
   * returned unchanged with `cancelled: false`.
   * @param raw - the operation arguments (`scanId` omitted = the active/latest scan).
   * @returns the scan row after the request.
   */
  cancelScan(raw: unknown): CancelScanResult {
    const args = objectArgs(raw)
    const requested = optionalString(args, 'scanId')
    const active = this.active
    if (active !== null && (requested === undefined || requested === active.scanId)) {
      active.controller.abort()
      if (active.kind === 'scan') this.store.markCancelling(active.scanId)
      else this.store.setDuplicateState(active.scanId, 'cancelling', null)
      return { cancelled: true, scan: this.store.readScan(active.scanId)! }
    }
    const scan = requested === undefined ? this.store.latestScan() : this.store.readScan(requested)
    if (scan === null) throw new AppError('not-found', `disk-space: no scan ${requested ?? ''}`)
    return { cancelled: false, scan }
  }

  /** List scans, newest first. */
  listScans(raw: unknown): ListScansResult {
    const args = objectArgs(raw)
    const limit = optionalInteger(args, 'limit', 20, { min: 1, max: 100 })
    return { scans: this.store.listScans(limit) }
  }

  /**
   * Browse one indexed directory's direct children (root-relative).
   * @param raw - the operation arguments.
   * @returns the page.
   */
  browseDirectory(raw: unknown): BrowsePage {
    const args = objectArgs(raw)
    const scanId = requiredString(args, 'scanId')
    const path = normalizeRelativePath(optionalText(args, 'path') ?? '')
    const offset = optionalInteger(args, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER })
    const limit = optionalInteger(args, 'limit', 100, { min: 1, max: 500 })
    this.requireScan(scanId)
    if (path !== '') {
      const kind = this.store.entryKind(scanId, path)
      if (kind === null) throw new AppError('not-found', `disk-space: no indexed path ${path}`)
      if (kind !== 'dir') throw new AppError('invalid-args', `disk-space: ${path} is not a directory`)
    }
    return this.store.browse(scanId, path, offset, limit)
  }

  /** List the largest indexed files. */
  listLargeFiles(raw: unknown): LargeFilesResult {
    const args = objectArgs(raw)
    const scanId = requiredString(args, 'scanId')
    const limit = optionalInteger(args, 'limit', 100, { min: 1, max: 500 })
    this.requireScan(scanId)
    return this.store.largeFiles(scanId, limit)
  }

  /**
   * Start duplicate-file analysis over one completed scan.
   * @param raw - the operation arguments.
   * @param ctx - the call context.
   * @returns the scan row with the duplicate state already `running`.
   */
  startDuplicateAnalysis(raw: unknown, ctx: OperationContext): ScanResult {
    const args = objectArgs(raw)
    const scanId = requiredString(args, 'scanId')
    const minSize = optionalInteger(args, 'minSize', 0, { min: 0, max: Number.MAX_SAFE_INTEGER })
    const scan = this.requireScan(scanId)
    if (scan.state !== 'completed') throw new AppError('scan-incomplete', 'disk-space: duplicate analysis needs a completed scan')
    if (this.active !== null) throw new AppError('busy', 'disk-space: another scan or duplicate analysis is running')
    this.store.replaceDuplicateGroups(scanId, [])
    this.store.setDuplicateState(scanId, 'running', null)
    const controller = new AbortController()
    this.active = { scanId, kind: 'duplicates', controller }

    ctx.startTask({ kind: 'duplicates', title: `disk-space duplicates ${scan.root}`, externalId: scanId }, async taskCtx => {
      const unlink = this.linkAbort(taskCtx.signal, controller)
      await new Promise<void>(resolve => { setImmediate(resolve) })
      try {
        if (controller.signal.aborted) throw abortError()
        const candidates = this.store.duplicateCandidates(scanId)
        const result = await findDuplicates({
          root: scan.root,
          candidates,
          minSize,
          signal: controller.signal,
          onProgress: (hashed, total) => { taskCtx.reportProgress(`hashing ${String(hashed)}/${String(total)}`, { hashed, total }) },
        }, this.duplicateIo)
        if (controller.signal.aborted) throw abortError()
        const summary: DuplicateSummary = {
          groups: result.groups.length,
          wastedBytes: result.wastedBytes,
          hashedFiles: result.hashedFiles,
          skippedFiles: result.skippedFiles,
          completedAt: Date.now(),
        }
        this.store.replaceDuplicateGroups(scanId, result.groups)
        this.store.setDuplicateState(scanId, 'completed', summary)
        taskCtx.notifyChanged()
        return { scanId, groups: summary.groups, wastedBytes: summary.wastedBytes }
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          this.store.setDuplicateState(scanId, 'cancelled', null)
          taskCtx.notifyChanged()
          throw abortError()
        }
        this.store.setDuplicateState(scanId, 'failed', null)
        taskCtx.notifyChanged()
        throw error
      } finally {
        unlink()
        this.active = null
      }
    })

    return { scan: this.store.readScan(scanId)!, scanId }
  }

  /** List one scan's duplicate groups. */
  listDuplicateGroups(raw: unknown): DuplicateListResult {
    const args = objectArgs(raw)
    const scanId = requiredString(args, 'scanId')
    const offset = optionalInteger(args, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER })
    const limit = optionalInteger(args, 'limit', 50, { min: 1, max: 500 })
    this.requireScan(scanId)
    return this.store.listDuplicateGroups(scanId, offset, limit)
  }

  /**
   * Move selected root-relative entries into the scan root's trash. Every
   * source is validated before any file moves; a move failure leaves that
   * source in place.
   * @param raw - the operation arguments (`scanId`, `paths`).
   * @param ctx - the call context (notified after a successful stage).
   * @returns the staged entries.
   */
  async stageEntries(raw: unknown, ctx: OperationContext): Promise<StageEntriesResult> {
    const args = objectArgs(raw)
    const scanId = requiredString(args, 'scanId')
    const paths = requiredStringArray(args, 'paths', 1000)
    const scan = this.requireScan(scanId)
    const sources: Array<{ relative: string; absolute: string; size: number }> = []
    for (const rawPath of paths) {
      const relative = normalizeRelativePath(rawPath)
      if (relative === '' || isInsideTrash(relative)) {
        throw new AppError('invalid-args', `disk-space: ${JSON.stringify(rawPath)} cannot be staged`)
      }
      const absolute = resolveInside(scan.root, relative)
      let size: number
      try {
        const stat = await lstat(absolute)
        size = stat.isDirectory() ? 0 : stat.size
      } catch {
        throw new AppError('not-found', `disk-space: ${rawPath} does not exist`)
      }
      sources.push({ relative, absolute, size })
    }

    const staged: TrashEntry[] = []
    for (const source of sources) {
      const id = `t_${randomUUID()}`
      const trashRelative = `${TRASH_DIR}/${id}/${basename(source.relative)}`
      const trashAbsolute = resolveInside(scan.root, trashRelative)
      try {
        await mkdir(dirname(trashAbsolute), { recursive: true })
        await rename(source.absolute, trashAbsolute)
      } catch (error) {
        throw new AppError('stage-failed', `disk-space: could not stage ${source.relative}: ${messageOf(error)}`)
      }
      const movedAt = Date.now()
      this.store.insertTrash({ id, scanId, sourcePath: source.relative, trashPath: trashRelative, size: source.size, movedAt })
      staged.push({
        id, scanId, root: scan.root, sourcePath: source.relative, trashPath: trashRelative, size: source.size, movedAt,
      })
    }
    ctx.notifyChanged()
    return { staged }
  }

  /** List the trash, newest first. */
  listTrash(raw: unknown): ListTrashResult {
    objectArgs(raw)
    return { entries: this.store.listTrash() }
  }

  /**
   * Restore one trashed entry to its original path. An existing destination is
   * never replaced: the conflict is reported and the entry stays in the trash.
   * @param raw - the operation arguments (`id`).
   * @param ctx - the call context.
   * @returns the restored path.
   */
  async restoreTrash(raw: unknown, ctx: OperationContext): Promise<RestoreTrashResult> {
    const args = objectArgs(raw)
    const id = requiredString(args, 'id')
    const entry = this.store.getTrash(id)
    if (entry === null) throw new AppError('not-found', `disk-space: no trash entry ${id}`)
    const destination = resolveInside(entry.root, entry.sourcePath)
    if (await pathExists(destination)) {
      throw new AppError('restore-conflict', `disk-space: ${entry.sourcePath} already exists; the trashed copy was not restored`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await rename(resolveInside(entry.root, entry.trashPath), destination)
    this.store.deleteTrash(id)
    ctx.notifyChanged()
    return { restored: { id, path: entry.sourcePath } }
  }

  /**
   * Permanently delete one trashed entry.
   * @param raw - the operation arguments (`id`).
   * @param ctx - the call context.
   * @returns whether a row was removed.
   */
  async purgeTrash(raw: unknown, ctx: OperationContext): Promise<PurgeTrashResult> {
    const args = objectArgs(raw)
    const id = requiredString(args, 'id')
    const entry = this.store.getTrash(id)
    if (entry === null) throw new AppError('not-found', `disk-space: no trash entry ${id}`)
    await rm(resolveInside(entry.root, entry.trashPath), { recursive: true, force: true })
    this.store.deleteTrash(id)
    ctx.notifyChanged()
    return { purged: true }
  }

  /**
   * Require one existing scan.
   * @param scanId - the scan identity.
   * @returns the row.
   * @throws AppError when the scan does not exist.
   */
  private requireScan(scanId: string): ScanRecord {
    const scan = this.store.readScan(scanId)
    if (scan === null) throw new AppError('not-found', `disk-space: no scan ${scanId}`)
    return scan
  }
}
