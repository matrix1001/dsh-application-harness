/**
 * The disk-space application's wire vocabulary: the scan row, its progress,
 * the index rows the page browses, duplicate groups and the reversible trash.
 * These shapes are shared by the host repository, the declaration and the
 * view package's own narrower (the view keeps a structural copy because it
 * never value-imports the host package).
 * @module
 */

/** One scan's lifecycle. `cancelling` is a request that has not settled yet. */
export type ScanState = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

/** The duplicate analysis's independent lifecycle inside one completed scan. */
export type DuplicateState = 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

/** Latest progress of one scan; transient, the rows below are the business result. */
export interface ScanProgress {
  /** Files indexed so far. */
  files: number
  /** Directories indexed so far. */
  dirs: number
  /** Sum of the indexed files' logical bytes. */
  bytes: number
  /** Entries skipped by policy or by an unreadable directory. */
  skipped: number
  /** The root-relative directory being walked, or `null` before the walk starts. */
  currentPath: string | null
}

/** A structured scan failure. */
export interface ScanError {
  /** Stable application code. */
  code: string
  /** Human-readable reason (never a stack trace). */
  message: string
}

/** The summary of one completed duplicate analysis. */
export interface DuplicateSummary {
  /** Number of duplicate groups kept. */
  groups: number
  /** Logically reclaimable bytes: each group's size × (copies − 1). */
  wastedBytes: number
  /** Files whose content was hashed. */
  hashedFiles: number
  /** Files that could not be hashed and were skipped. */
  skippedFiles: number
  /** When the analysis settled (epoch ms). */
  completedAt: number
}

/** One scan row as the host stores it and the page reads it. */
export interface ScanRecord {
  /** The scan identity (`s_` + uuid). */
  scanId: string
  /** The canonical absolute root. */
  root: string
  /** The scan's lifecycle state. */
  state: ScanState
  /** When the walk started (epoch ms). */
  startedAt: number
  /** When the scan settled (epoch ms), or `null` while it runs. */
  endedAt: number | null
  /** Latest progress snapshot. */
  progress: ScanProgress
  /** Indexed files. */
  files: number
  /** Indexed directories. */
  dirs: number
  /** Indexed files' logical bytes. */
  bytes: number
  /** Root-relative exclusions the walk honoured. */
  excludes: string[]
  /** Whether the walk was allowed to cross filesystems. */
  crossFileSystems: boolean
  /** The failure, when the scan failed. */
  error: ScanError | null
  /** The duplicate analysis's own state. */
  duplicateState: DuplicateState
  /** The duplicate analysis's summary once completed. */
  duplicate: DuplicateSummary | null
}

/** One indexed entry (a file, or a directory with its subtree's byte total). */
export interface BrowseEntry {
  /** Path relative to the scan root, `/`-joined. */
  path: string
  /** The entry basename. */
  name: string
  /** File or directory. */
  kind: 'file' | 'dir'
  /** Logical bytes (a directory aggregates its subtree). */
  size: number
  /** Last modification time (epoch ms). */
  mtime: number
}

/** One page of a root-relative directory browse. */
export interface BrowsePage {
  /** The scan being browsed. */
  scanId: string
  /** The root-relative directory (empty = the scan root). */
  path: string
  /** The direct children, directories first then size descending. */
  entries: BrowseEntry[]
  /** The directory's direct child count. */
  total: number
  /** The offset this answer used. */
  offset: number
  /** The limit this answer used. */
  limit: number
}

/** One duplicate group as recorded evidence. */
export interface DuplicateGroup {
  /** Stable group id within the scan (`g_1`, `g_2`, …). */
  groupId: string
  /** The content hash shared by the group (sha256). */
  hash: string
  /** One copy's size in bytes. */
  size: number
  /** The root-relative paths, sorted. */
  paths: string[]
  /** Logically reclaimable bytes: `size × (paths.length − 1)`. */
  wastedBytes: number
}

/** One file candidate the duplicate analysis considers. */
export interface DuplicateCandidate {
  /** Root-relative path. */
  path: string
  /** Logical size in bytes. */
  size: number
}

/** One trash row as listed: the row plus the scan root it belongs to. */
export interface TrashEntry {
  /** The trash identity (`t_` + uuid). */
  id: string
  /** The scan that staged the entry. */
  scanId: string
  /** The canonical scan root the entry came from. */
  root: string
  /** The original root-relative path. */
  sourcePath: string
  /** Where the entry now sits, root-relative (under the root's trash directory). */
  trashPath: string
  /** The staged logical bytes. */
  size: number
  /** When the entry was moved to the trash (epoch ms). */
  movedAt: number
}

/** The `startScan` result. */
export interface ScanResult {
  /** The created scan row as it stands when the call returns. */
  scan: ScanRecord
  /** The scan identity (the value a caller needs before it can read/cancel). */
  scanId: string
}

/** The `readScan` result. */
export interface ReadScanResult {
  /** The scan, or `null` when no scan was ever started and no id was given. */
  scan: ScanRecord | null
}

/** The `listScans` result. */
export interface ListScansResult {
  /** The scans, newest first. */
  scans: ScanRecord[]
}

/** The `cancelScan` result. */
export interface CancelScanResult {
  /** Whether a running scan/duplicate analysis accepted the cancellation. */
  cancelled: boolean
  /** The scan row after the request. */
  scan: ScanRecord
}

/** The `listLargeFiles` result. */
export interface LargeFilesResult {
  /** The files, size descending. */
  files: BrowseEntry[]
  /** How many indexed files exist in total. */
  total: number
}

/** The `listDuplicateGroups` result. */
export interface DuplicateListResult {
  /** The page of groups, wasted bytes descending. */
  groups: DuplicateGroup[]
  /** How many groups the scan has. */
  total: number
  /** Every group's wasted bytes (not only the page). */
  wastedBytes: number
}

/** The `listTrash` result. */
export interface ListTrashResult {
  /** The staged entries, newest first. */
  entries: TrashEntry[]
}

/** The `stageEntries` result. */
export interface StageEntriesResult {
  /** The newly staged entries. */
  staged: TrashEntry[]
}

/** The `restoreTrash` result. */
export interface RestoreTrashResult {
  /** The restored entry's identity and path. */
  restored: {
    id: string
    path: string
  }
}

/** The `purgeTrash` result. */
export interface PurgeTrashResult {
  /** Whether a row was removed and its bytes released. */
  purged: boolean
}
