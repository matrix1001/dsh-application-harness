/**
 * The application's own SQLite index. The database lives outside the harness's
 * unified store (`$DSH_HOME/application-harness/disk-space/index.db`) because a scan
 * writes tens of thousands of rows with its own schema and lifecycle. The file
 * is the application's durable source of truth: scans, their entries, the
 * duplicate groups and the reversible trash.
 * @module
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  BrowseEntry, BrowsePage, DuplicateCandidate, DuplicateGroup, DuplicateState, DuplicateSummary,
  ScanError, ScanProgress, ScanRecord, ScanState, TrashEntry,
} from './types.ts'

/** The schema version this build writes and accepts. */
export const SCHEMA_VERSION = 1

/** One row returned by a prepared statement (`unknown` before mapping). */
type Row = Record<string, unknown>

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scans (
    scan_id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    progress TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0,
    dirs INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    excludes TEXT NOT NULL DEFAULT '[]',
    cross_file_systems INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    duplicate_state TEXT NOT NULL DEFAULT 'idle',
    duplicate TEXT
  );
  CREATE TABLE IF NOT EXISTS entries (
    scan_id TEXT NOT NULL,
    path TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    PRIMARY KEY (scan_id, path)
  );
  CREATE INDEX IF NOT EXISTS entries_parent ON entries (scan_id, parent_path);
  CREATE INDEX IF NOT EXISTS entries_size ON entries (scan_id, kind, size DESC);
  CREATE TABLE IF NOT EXISTS duplicate_groups (
    scan_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    paths TEXT NOT NULL,
    wasted_bytes INTEGER NOT NULL,
    PRIMARY KEY (scan_id, group_id)
  );
  CREATE TABLE IF NOT EXISTS trash (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    trash_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    moved_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/** One entry row as the walker hands it to the store (the path is already root-relative). */
export interface EntryRecord {
  /** Root-relative path. */
  path: string
  /** Root-relative parent (empty at the top level). */
  parentPath: string
  /** Basename. */
  name: string
  /** File or directory. */
  kind: 'file' | 'dir'
  /** Logical bytes (a directory's subtree total). */
  size: number
  /** Modification time (epoch ms). */
  mtime: number
}

/** The inputs of one scan row creation. */
export interface CreateScanInput {
  /** The scan identity. */
  scanId: string
  /** The canonical root. */
  root: string
  /** The root-relative exclusions. */
  excludes: string[]
  /** Whether the walk may cross filesystems. */
  crossFileSystems: boolean
  /** When the walk started. */
  startedAt: number
  /** The initial (empty) progress. */
  progress: ScanProgress
}

/** One trash row joined with its scan root. */
export type TrashRow = TrashEntry

/** Parse the stored JSON progress. */
function parseProgress(value: unknown): ScanProgress {
  return JSON.parse(String(value)) as ScanProgress
}

/** Map one scan row. */
function scanOf(row: Row): ScanRecord {
  return {
    scanId: String(row.scan_id),
    root: String(row.root),
    state: String(row.state) as ScanState,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    progress: parseProgress(row.progress),
    files: Number(row.files),
    dirs: Number(row.dirs),
    bytes: Number(row.bytes),
    excludes: JSON.parse(String(row.excludes)) as string[],
    crossFileSystems: Number(row.cross_file_systems) === 1,
    error: row.error === null ? null : JSON.parse(String(row.error)) as ScanError,
    duplicateState: String(row.duplicate_state) as DuplicateState,
    duplicate: row.duplicate === null ? null : JSON.parse(String(row.duplicate)) as DuplicateSummary,
  }
}

/** Map one browse row. */
function entryOf(row: Row): BrowseEntry {
  return {
    path: String(row.path),
    name: String(row.name),
    kind: String(row.kind) as 'file' | 'dir',
    size: Number(row.size),
    mtime: Number(row.mtime),
  }
}

/** Map one duplicate-group row. */
function groupOf(row: Row): DuplicateGroup {
  return {
    groupId: String(row.group_id),
    hash: String(row.hash),
    size: Number(row.size),
    paths: JSON.parse(String(row.paths)) as string[],
    wastedBytes: Number(row.wasted_bytes),
  }
}

/** Map one trash row. */
function trashOf(row: Row): TrashRow {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    root: String(row.root),
    sourcePath: String(row.source_path),
    trashPath: String(row.trash_path),
    size: Number(row.size),
    movedAt: Number(row.moved_at),
  }
}

/**
 * The application's SQLite index. One connection, synchronous statements (the
 * operations call it from the host's event loop) and one serialized writer.
 * The class never exposes the connection: callers ask for rows, not SQL.
 */
export class DiskStore {
  private readonly db: DatabaseSync

  /**
   * Open (and, on a first run, create) the index.
   * @param databasePath - the database file; `:memory:` is accepted by tests
   *   that do not need a restart.
   * @throws AppError when the database carries an unknown schema version.
   */
  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec(SCHEMA)
    const meta = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as Row | undefined
    if (meta === undefined) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schemaVersion', String(SCHEMA_VERSION))
    } else if (Number(meta.value) !== SCHEMA_VERSION) {
      this.db.close()
      throw new AppError('storage-version-unsupported', `disk-space: unsupported index schema version ${String(meta.value)}`)
    }
  }

  /** Close the connection (the row's dispose path). */
  close(): void {
    this.db.close()
  }

  /**
   * Run one synchronous write inside a transaction.
   * @param work - the statements to commit.
   */
  private transaction(work: () => void): void {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Insert one scan row. */
  createScan(input: CreateScanInput): void {
    this.db.prepare(`
      INSERT INTO scans (scan_id, root, state, started_at, progress, excludes, cross_file_systems)
      VALUES (?, ?, 'running', ?, ?, ?, ?)
    `).run(
      input.scanId,
      input.root,
      input.startedAt,
      JSON.stringify(input.progress),
      JSON.stringify(input.excludes),
      input.crossFileSystems ? 1 : 0,
    )
  }

  /** Replace the transient progress snapshot. */
  updateProgress(scanId: string, progress: ScanProgress): void {
    this.db.prepare('UPDATE scans SET progress = ? WHERE scan_id = ?').run(JSON.stringify(progress), scanId)
  }

  /** Move one scan into `cancelling` while its walk unwinds. */
  markCancelling(scanId: string): void {
    this.db.prepare("UPDATE scans SET state = 'cancelling' WHERE scan_id = ? AND state = 'running'").run(scanId)
  }

  /** Settle one scan with its final counters and (when failed) its reason. */
  finishScan(scanId: string, state: ScanState, progress: ScanProgress, totals: { files: number; dirs: number; bytes: number }, error: ScanError | null): void {
    this.db.prepare(`
      UPDATE scans SET state = ?, ended_at = ?, progress = ?, files = ?, dirs = ?, bytes = ?, error = ?
      WHERE scan_id = ?
    `).run(state, Date.now(), JSON.stringify(progress), totals.files, totals.dirs, totals.bytes, error === null ? null : JSON.stringify(error), scanId)
  }

  /** Read one scan. */
  readScan(scanId: string): ScanRecord | null {
    const row = this.db.prepare('SELECT * FROM scans WHERE scan_id = ?').get(scanId) as Row | undefined
    return row === undefined ? null : scanOf(row)
  }

  /** Read the newest scan, when there is one. */
  latestScan(): ScanRecord | null {
    const row = this.db.prepare('SELECT * FROM scans ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as Row | undefined
    return row === undefined ? null : scanOf(row)
  }

  /** List scans, newest first. */
  listScans(limit: number): ScanRecord[] {
    const rows = this.db.prepare('SELECT * FROM scans ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]
    return rows.map(scanOf)
  }

  /**
   * Insert one scan's complete entry set in one transaction.
   * @param scanId - the owning scan.
   * @param entries - the walked entries.
   * @throws when the set violates the primary key (the transaction rolls back).
   */
  insertEntries(scanId: string, entries: readonly EntryRecord[]): void {
    const statement = this.db.prepare(`
      INSERT INTO entries (scan_id, path, parent_path, name, kind, size, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.transaction(() => {
      for (const entry of entries) {
        statement.run(scanId, entry.path, entry.parentPath, entry.name, entry.kind, entry.size, entry.mtime)
      }
    })
  }

  /** The kind of one indexed path, or `null` when it is not in the index. */
  entryKind(scanId: string, path: string): 'file' | 'dir' | null {
    const row = this.db.prepare('SELECT kind FROM entries WHERE scan_id = ? AND path = ?').get(scanId, path) as Row | undefined
    return row === undefined ? null : String(row.kind) as 'file' | 'dir'
  }

  /** Browse one indexed directory's direct children. */
  browse(scanId: string, path: string, offset: number, limit: number): BrowsePage {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE scan_id = ? AND parent_path = ?').get(scanId, path) as Row).n)
    const rows = this.db.prepare(`
      SELECT path, name, kind, size, mtime FROM entries
      WHERE scan_id = ? AND parent_path = ?
      ORDER BY CASE kind WHEN 'dir' THEN 0 ELSE 1 END, size DESC, name ASC
      LIMIT ? OFFSET ?
    `).all(scanId, path, limit, offset) as Row[]
    return { scanId, path, entries: rows.map(entryOf), total, offset, limit }
  }

  /** List the indexed files, largest first. */
  largeFiles(scanId: string, limit: number): { files: BrowseEntry[]; total: number } {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE scan_id = ? AND kind = 'file'").get(scanId) as Row).n)
    const rows = this.db.prepare(`
      SELECT path, name, kind, size, mtime FROM entries
      WHERE scan_id = ? AND kind = 'file'
      ORDER BY size DESC, path ASC LIMIT ?
    `).all(scanId, limit) as Row[]
    return { files: rows.map(entryOf), total }
  }

  /** The duplicate analysis's candidates: non-empty indexed files. */
  duplicateCandidates(scanId: string): DuplicateCandidate[] {
    const rows = this.db.prepare("SELECT path, size FROM entries WHERE scan_id = ? AND kind = 'file' AND size > 0 AND path NOT LIKE '.disk-space-trash/%'").all(scanId) as Row[]
    return rows.map(row => ({ path: String(row.path), size: Number(row.size) }))
  }

  /** Replace one scan's duplicate groups (an empty list clears them). */
  replaceDuplicateGroups(scanId: string, groups: readonly DuplicateGroup[]): void {
    const statement = this.db.prepare(`
      INSERT INTO duplicate_groups (scan_id, group_id, hash, size, paths, wasted_bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.transaction(() => {
      this.db.prepare('DELETE FROM duplicate_groups WHERE scan_id = ?').run(scanId)
      for (const group of groups) {
        statement.run(scanId, group.groupId, group.hash, group.size, JSON.stringify(group.paths), group.wastedBytes)
      }
    })
  }

  /** Set the duplicate analysis's independent state (and optional summary). */
  setDuplicateState(scanId: string, state: DuplicateState, summary: DuplicateSummary | null): void {
    this.db.prepare('UPDATE scans SET duplicate_state = ?, duplicate = ? WHERE scan_id = ?')
      .run(state, summary === null ? null : JSON.stringify(summary), scanId)
  }

  /** List one scan's duplicate groups, wasted bytes descending. */
  listDuplicateGroups(scanId: string, offset: number, limit: number): { groups: DuplicateGroup[]; total: number; wastedBytes: number } {
    const totalRow = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(wasted_bytes), 0) AS wasted FROM duplicate_groups WHERE scan_id = ?').get(scanId) as Row
    const rows = this.db.prepare(`
      SELECT group_id, hash, size, paths, wasted_bytes FROM duplicate_groups
      WHERE scan_id = ? ORDER BY wasted_bytes DESC, group_id ASC LIMIT ? OFFSET ?
    `).all(scanId, limit, offset) as Row[]
    return { groups: rows.map(groupOf), total: Number(totalRow.n), wastedBytes: Number(totalRow.wasted) }
  }

  /** Insert one trash row. */
  insertTrash(input: { id: string; scanId: string; sourcePath: string; trashPath: string; size: number; movedAt: number }): void {
    this.db.prepare(`
      INSERT INTO trash (id, scan_id, source_path, trash_path, size, moved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.scanId, input.sourcePath, input.trashPath, input.size, input.movedAt)
  }

  /** List every trash row with its scan root, newest first. */
  listTrash(): TrashRow[] {
    const rows = this.db.prepare(`
      SELECT t.id, t.scan_id, t.source_path, t.trash_path, t.size, t.moved_at, s.root
      FROM trash t JOIN scans s ON s.scan_id = t.scan_id
      ORDER BY t.moved_at DESC, t.rowid DESC
    `).all() as Row[]
    return rows.map(trashOf)
  }

  /** Read one trash row with its scan root. */
  getTrash(id: string): TrashRow | null {
    const row = this.db.prepare(`
      SELECT t.id, t.scan_id, t.source_path, t.trash_path, t.size, t.moved_at, s.root
      FROM trash t JOIN scans s ON s.scan_id = t.scan_id
      WHERE t.id = ?
    `).get(id) as Row | undefined
    return row === undefined ? null : trashOf(row)
  }

  /** Remove one trash row (after a successful restore or purge). */
  deleteTrash(id: string): void {
    this.db.prepare('DELETE FROM trash WHERE id = ?').run(id)
  }

  /**
   * Keep the newest `keep` scan indexes that no trash row depends on. A scan
   * with staged trash is retained so every restore row keeps its root; the
   * caller can prune again after the trash is empty.
   * @param keep - number of newest prunable scans to retain.
   * @returns number of scans removed.
   */
  pruneScans(keep: number): number {
    if (!Number.isInteger(keep) || keep < 1) throw new AppError('invalid-args', 'disk-space: scan retention must be a positive integer')
    const rows = this.db.prepare(`
      SELECT scan_id FROM scans
      WHERE scan_id NOT IN (SELECT DISTINCT scan_id FROM trash)
      ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?
    `).all(keep) as Row[]
    const ids = rows.map(row => String(row.scan_id))
    if (ids.length === 0) return 0
    this.transaction(() => {
      for (const id of ids) {
        this.db.prepare('DELETE FROM entries WHERE scan_id = ?').run(id)
        this.db.prepare('DELETE FROM duplicate_groups WHERE scan_id = ?').run(id)
        this.db.prepare('DELETE FROM scans WHERE scan_id = ?').run(id)
      }
    })
    return ids.length
  }
}
