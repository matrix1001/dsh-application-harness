// @vitest-environment jsdom
/**
 * Shared harness for the disk-space view specs: wire fixtures, a controllable
 * `call` stub (recorded, answered per operation or settled on demand), a
 * `cancel` recorder, a controllable change subscription and a ready-render
 * helper that settles the page's asynchronous first read under fake timers.
 *
 * The page receives only the shell's `ApplicationViewProps` plus this
 * package's translator and an optional picker callback — the same face the
 * registration hands it.
 */
import { act, render } from '@testing-library/react'
import { vi } from 'vitest'
import type { CallOutcome, JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationUiState, ApplicationUiStore, ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { DiskSpaceView, type BrowseEntry, type DiskSpaceTranslate, type DiskSpaceViewProps, type DuplicateGroup, type Scan, type TrashEntry } from '../src/client/DiskSpaceView.tsx'
import { zh, type DiskSpaceKey } from '../src/client/locales.ts'

/** The translate function the views receive (Chinese by default). */
export function translator(dictionary: Record<string, string> = zh): DiskSpaceTranslate {
  return (key: DiskSpaceKey, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
  }
}

// ── wire fixtures ──────────────────────────────────────────────────────────

/** The default completed scan. */
export function scanFixture(overrides: Partial<Scan> = {}): Scan {
  return {
    scanId: 's_1',
    root: '/srv/data',
    state: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_042_000,
    progress: { files: 3, dirs: 2, bytes: 1000, skipped: 0, currentPath: null },
    files: 3,
    dirs: 2,
    bytes: 1000,
    excludes: [],
    crossFileSystems: false,
    error: null,
    duplicateState: 'completed',
    duplicate: { groups: 1, wastedBytes: 100, hashedFiles: 3, skippedFiles: 0, completedAt: 1_700_000_100_000 },
    ...overrides,
  }
}

/** The root browse page. */
export function rootEntries(): { entries: BrowseEntry[]; total: number } {
  return {
    entries: [
      { path: 'Code', name: 'Code', kind: 'dir', size: 600, mtime: 1_700_000_000_000 },
      { path: 'Docs', name: 'Docs', kind: 'dir', size: 300, mtime: 1_700_000_000_000 },
      { path: 'a.txt', name: 'a.txt', kind: 'file', size: 100, mtime: 1_700_000_000_000 },
    ],
    total: 3,
  }
}

/** The large-file page. */
export function largeFiles(): { files: BrowseEntry[]; total: number } {
  return {
    files: [{ path: 'a.txt', name: 'a.txt', kind: 'file', size: 100, mtime: 1_700_000_000_000 }],
    total: 1,
  }
}

/** The duplicate-group page. */
export function groupList(): { groups: DuplicateGroup[]; total: number; wastedBytes: number } {
  return {
    groups: [
      { groupId: 'g_1', hash: 'h1', size: 100, paths: ['Code/a.bin', 'Docs/a.bin'], wastedBytes: 100 },
      { groupId: 'g_2', hash: 'h2', size: 50, paths: ['Code/b.bin', 'Docs/b.bin'], wastedBytes: 50 },
    ],
    total: 2,
    wastedBytes: 150,
  }
}

/** The trash page. */
export function trashList(): { entries: TrashEntry[] } {
  return {
    entries: [
      { id: 't_1', scanId: 's_1', root: '/srv/data', sourcePath: 'Code/a.bin', trashPath: '.disk-space-trash/t_1/a.bin', size: 100, movedAt: 1_700_000_200_000 },
      { id: 't_2', scanId: 's_1', root: '/srv/data', sourcePath: 'Docs/b.bin', trashPath: '.disk-space-trash/t_2/b.bin', size: 50, movedAt: 1_700_000_300_000 },
    ],
  }
}

// ── outcomes ───────────────────────────────────────────────────────────────

/** One successful outcome carrying a value. */
export function ok(value: unknown): CallOutcome {
  return { callId: 'call-1', status: 'success', result: value as JsonValue }
}

/** One failed outcome (the operation ran and refused/failed). */
export function failed(message: string, code = 'disk-failed'): CallOutcome {
  return { callId: 'call-1', status: 'failed', error: { code, message } }
}

/** One rejected outcome (the operation never ran). */
export function rejected(code: string, message: string): CallOutcome {
  return { callId: 'call-1', status: 'rejected', error: { code: code as never, message } }
}

/** One cancelled outcome. */
export function cancelled(): CallOutcome {
  return { callId: 'call-1', status: 'cancelled' }
}

// ── call stub ──────────────────────────────────────────────────────────────

/** One recorded call. */
export interface RecordedCall {
  op: string
  args: Record<string, unknown>
  requestId: string | undefined
}

/** A responder: the outcome for one call, or `undefined` to leave it pending. */
export type Responder = (args: Record<string, unknown>, requestId: string | undefined) => CallOutcome | undefined

/** The call stub. */
export interface CallStub {
  call: (op: string, args: JsonValue, requestId?: string) => Promise<CallOutcome>
  calls: RecordedCall[]
  /** Register a persistent answer for one operation. */
  respond: (op: string, make: Responder) => void
  /** Answer the NEXT call of one operation. */
  once: (op: string, make: Responder) => void
  /** Answer every pending call. */
  settle: (outcome: CallOutcome) => void
  /** Reject every pending call. */
  reject: (error: unknown) => void
}

/**
 * Build one call stub.
 * @param answers - the persistent answers per operation.
 * @returns the stub.
 */
export function makeCall(answers: Partial<Record<string, Responder>> = {}): CallStub {
  const calls: RecordedCall[] = []
  const responders = new Map<string, Responder>(Object.entries(answers) as Array<[string, Responder]>)
  const oneShots = new Map<string, Responder[]>()
  const pending: Array<{ settle: (outcome: CallOutcome) => void; fail: (error: unknown) => void }> = []
  return {
    call: (op, args, requestId) => new Promise<CallOutcome>((resolve, reject) => {
      const record: RecordedCall = { op, args: (args ?? {}) as Record<string, unknown>, requestId }
      calls.push(record)
      const queue = oneShots.get(op)
      const oneShot = queue?.shift()
      if (oneShot !== undefined) {
        const outcome = oneShot(record.args, requestId)
        if (outcome !== undefined) { resolve(outcome); return }
      }
      const responder = responders.get(op)
      const outcome = responder?.(record.args, requestId)
      if (responder !== undefined && outcome !== undefined) { resolve(outcome); return }
      pending.push({ settle: resolve, fail: reject })
    }),
    calls,
    respond: (op, make) => { responders.set(op, make) },
    once: (op, make) => {
      const queue = oneShots.get(op) ?? []
      queue.push(make)
      oneShots.set(op, queue)
    },
    settle: (outcome) => { for (const entry of pending.splice(0)) entry.settle(outcome) },
    reject: (error) => { for (const entry of pending.splice(0)) entry.fail(error) },
  }
}

/** The default happy answers for one scan. */
export function happyCalls(scan: Scan = scanFixture()): CallStub {
  return makeCall({
    listScans: () => ok({ scans: [scan] }),
    listTrash: () => ok(trashList()),
    browseDirectory: () => ok(rootEntries()),
    listLargeFiles: () => ok(largeFiles()),
    listDuplicateGroups: () => ok(groupList()),
    readScan: () => ok({ scan }),
    startScan: () => ok({ scan }),
    cancelScan: () => ok({ cancelled: true, scan: { ...scan, state: 'cancelled' } }),
    startDuplicateAnalysis: () => ok({ scan: { ...scan, duplicateState: 'running' } }),
    stageEntries: () => ok({ staged: trashList().entries }),
    restoreTrash: () => ok({ restored: { id: 't_1', path: 'Code/a.bin' } }),
    purgeTrash: () => ok({ purged: true }),
  })
}

// ── small shell faces ──────────────────────────────────────────────────────

/** A `cancel` recorder. */
export function makeCancel(): { cancel: (requestId: string) => void; ids: string[] } {
  const ids: string[] = []
  return { cancel: (requestId) => { ids.push(requestId) }, ids }
}

/** A controllable `onChanged`. */
export function makeChanged(): { onChanged: (listener: () => void) => () => void; fire: () => void } {
  const listeners = new Set<() => void>()
  return {
    onChanged: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    fire: () => { for (const listener of [...listeners]) listener() },
  }
}

/** The shell's remaining props (the page reads none of them in these specs). */
export function shellProps(call: CallStub['call']): ApplicationViewProps {
  return {
    call,
    cancel: makeCancel().cancel,
    onChanged: makeChanged().onChanged,
    running: false,
    pageContext: { report: () => () => undefined },
    openManagement: () => undefined,
    claimProgress: () => () => undefined,
    viewport: { report: () => () => undefined },
    ui: {
      getSnapshot: () => ({}),
      set: () => undefined,
      subscribe: () => () => undefined,
    },
  }
}

/** The options one render accepts. */
export interface RenderOptions {
  t?: DiskSpaceTranslate
  pickDirectory?: () => Promise<string | undefined>
  changed?: ReturnType<typeof makeChanged>
}

/** The ready-render result. */
export interface RenderResult {
  utils: ReturnType<typeof render>
  changed: ReturnType<typeof makeChanged>
}

/** Flush the page's pending async work (React act + repeated microtask turns). */
export async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Advance past the page's polling interval (exactly this window), then flush its awaits. */
export async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await flush()
}

/**
 * Render the page and settle its first read.
 * @param stub - the call stub.
 * @param options - translator/picker/change overrides.
 * @returns the render result.
 */
export async function renderReady(stub: CallStub, options: RenderOptions = {}): Promise<RenderResult> {
  const changed = options.changed ?? makeChanged()
  const props: DiskSpaceViewProps = {
    ...shellProps(stub.call),
    onChanged: changed.onChanged,
    t: options.t ?? translator(),
    ...(options.pickDirectory === undefined ? {} : { pickDirectory: options.pickDirectory }),
  }
  const utils = render(<DiskSpaceView {...props} />)
  await flush()
  return { utils, changed }
}

/** The test UI store: a merge-on-set snapshot observable (the framework's contract). */
export interface UiStub extends ApplicationUiStore {
  /** The current fields. */
  fields: () => ApplicationUiState
}

/** Build one application's view-state store. */
export function makeUi(initial: ApplicationUiState = {}): UiStub {
  let state: ApplicationUiState = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    set: (patch) => {
      const next = { ...state }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    fields: () => state,
  }
}

/** One DOM node by its data anchor (accepts the ready-render result or its utils). */
export function node(view: RenderResult | ReturnType<typeof render>, selector: string): HTMLElement | null {
  const utils = 'utils' in view ? view.utils : view
  return utils.container.querySelector(selector)
}

/** All DOM nodes by a data anchor (accepts the ready-render result or its utils). */
export function nodes(view: RenderResult | ReturnType<typeof render>, selector: string): HTMLElement[] {
  const utils = 'utils' in view ? view.utils : view
  return [...utils.container.querySelectorAll(selector)].map(element => element as HTMLElement)
}
