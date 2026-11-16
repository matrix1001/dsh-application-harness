// @vitest-environment jsdom
/**
 * The disk-space page: the empty state, the four summaries, the treemap and
 * the browse drill-down, start/progress/poll/cancel, the duplicate workflow,
 * the reversible trash, scan history, the picker fallback and every failure
 * state the page can show. Every shell outcome is scripted through the call
 * stub, so the suite covers the page's decisions without a host.
 */
import { cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import {
  advance, cancelled, failed, flush, groupList, happyCalls, largeFiles, makeCall, makeChanged, node, nodes,
  ok, rejected, renderReady, rootEntries, scanFixture, translator, trashList, type CallStub,
} from './harness.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

/** The default running scan returned by a start operation. */
function runningScan(overrides = {}) {
  return scanFixture({
    state: 'running',
    endedAt: null,
    duplicateState: 'idle',
    duplicate: null,
    progress: { files: 1, dirs: 1, bytes: 100, skipped: 0, currentPath: 'Code' },
    ...overrides,
  })
}

/** Build a stub whose first calls are the bootstrap reads and whose details are empty. */
function emptyStub(): CallStub {
  return makeCall({
    listScans: () => ok({ scans: [] }),
    listTrash: () => ok({ entries: [] }),
    browseDirectory: () => ok({ entries: [] }),
    listLargeFiles: () => ok({ files: [] }),
    listDuplicateGroups: () => ok({ groups: [], total: 0, wastedBytes: 0 }),
  })
}

describe('empty state and history', () => {
  it('shows the empty prompt before any scan and an empty history panel', async () => {
    const stub = emptyStub()
    const view = await renderReady(stub)
    expect(node(view, '[data-disk-empty]')?.textContent).toBe(zh['view.empty'])
    expect(node(view, '[data-disk-error]')).toBeNull()
    expect(stub.calls.map(call => call.op)).toEqual(['listScans', 'listTrash'])

    fireEvent.click(node(view, '[data-disk-history]')!)
    expect(node(view, '[data-disk-history-panel]')).toBeTruthy()
    expect(node(view, '[data-disk-history-empty]')?.textContent).toBe(zh['view.history.empty'])
    fireEvent.click(node(view, '[data-disk-history]')!)
    expect(node(view, '[data-disk-history-panel]')).toBeNull()
  })
})

describe('completed scan', () => {
  it('renders the four summaries, treemap, tables and files; rows drill down and return to root', async () => {
    const stub = happyCalls()
    const view = await renderReady(stub)
    expect(node(view, '[data-disk-summary-total]')?.textContent).toContain('1000 B')
    expect(node(view, '[data-disk-summary-total]')?.textContent).toContain('3 个文件 · 2 个目录')
    expect(node(view, '[data-disk-summary-largest]')?.textContent).toContain('Code')
    expect(node(view, '[data-disk-summary-largest]')?.textContent).toContain('60.0%')
    expect(node(view, '[data-disk-summary-duplicates]')?.textContent).toContain('100 B')
    expect(node(view, '[data-disk-summary-trash]')?.textContent).toContain('150 B')
    expect(node(view, '[data-disk-summary-trash]')?.textContent).toContain('2 项')
    expect(nodes(view, '[data-disk-treemap] [data-disk-block]')).toHaveLength(2)
    expect(node(view, '[data-disk-block="Code"]')?.textContent).toContain('Code')
    expect(nodes(view, '[data-disk-row]')).toHaveLength(2)
    expect(nodes(view, '[data-disk-file-row]')).toHaveLength(1)

    // A treemap block and a table row both open the same browse operation.
    fireEvent.click(node(view, '[data-disk-block="Code"]')!)
    await flush()
    expect(stub.calls.filter(call => call.op === 'browseDirectory').at(-1)?.args.path).toBe('Code')
    expect(node(view, '[data-disk-notice]')?.textContent).toContain('Code')
    expect(node(view, '[data-disk-breadcrumb]')).toBeTruthy()
    fireEvent.keyDown(node(view, '[data-disk-row="Docs"]')!, { key: 'Enter' })
    await flush()
    expect(stub.calls.filter(call => call.op === 'browseDirectory').at(-1)?.args.path).toBe('Docs')
    fireEvent.click(node(view, '[data-disk-row="Docs"]')!)
    await flush()

    fireEvent.click(node(view, '[data-disk-breadcrumb]')!)
    await flush()
    expect(stub.calls.filter(call => call.op === 'browseDirectory').at(-1)?.args.path).toBe('')

    stub.respond('browseDirectory', () => failed('browse refused'))
    fireEvent.click(node(view, '[data-disk-block="Code"]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('browse refused')
  })

  it('falls back to file blocks when the directory has no subdirectories', async () => {
    const stub = happyCalls()
    stub.respond('browseDirectory', () => ok({ entries: [{ path: 'only.txt', name: 'only.txt', kind: 'file', size: 10, mtime: 1 }], total: 1 }))
    const view = await renderReady(stub)
    expect(nodes(view, '[data-disk-block]')).toHaveLength(1)
    expect(node(view, '[data-disk-block="only.txt"]')?.getAttribute('data-disk-block-kind')).toBe('file')
    expect(node(view, '[data-disk-dirs-empty]')?.textContent).toBe(zh['view.browse.noDirs'])
    expect(node(view, '[data-disk-summary-largest]')?.textContent).toContain(zh['view.summary.none'])
  })

  it('renders every empty section when the index has nothing', async () => {
    const stub = happyCalls()
    stub.respond('browseDirectory', () => ok({ entries: [], total: 0 }))
    stub.respond('listLargeFiles', () => ok({ files: [], total: 0 }))
    stub.respond('listDuplicateGroups', () => ok({ groups: [], total: 0, wastedBytes: 0 }))
    stub.respond('listTrash', () => ok({ entries: [] }))
    const view = await renderReady(stub)
    expect(node(view, '[data-disk-treemap-empty]')?.textContent).toBe(zh['view.browse.empty'])
    expect(node(view, '[data-disk-dirs-empty]')?.textContent).toBe(zh['view.browse.noDirs'])
    expect(node(view, '[data-disk-files-empty]')?.textContent).toBe(zh['view.browse.noFiles'])
    fireEvent.click(node(view, '[data-disk-tab="duplicates"]')!)
    expect(node(view, '[data-disk-duplicates-empty]')).toBeTruthy()
    fireEvent.click(node(view, '[data-disk-tab="trash"]')!)
    expect(node(view, '[data-disk-trash-empty]')?.textContent).toBe(zh['view.trash.empty'])
  })

  it('shows a recorded scan failure instead of a summary error', async () => {
    const failedScan = scanFixture({ state: 'failed', endedAt: 1, error: { code: 'scan-failed', message: 'disk went away' }, duplicateState: 'idle', duplicate: null })
    const stub = happyCalls(failedScan)
    const view = await renderReady(stub)
    expect(node(view, '[data-disk-scan-error]')?.textContent).toContain('disk went away')
    expect(node(view, '[data-disk-summary]')).toBeTruthy()
  })

  it('labels the largest-directory, file and treemap truncation instead of silently cutting', async () => {
    const stub = happyCalls()
    const entries = [
      ...Array.from({ length: 12 }, (_, index) => ({ path: `Dir${index}`, name: `Dir${index}`, kind: 'dir' as const, size: 100 - index, mtime: 1_700_000_000_000 })),
      ...Array.from({ length: 8 }, (_, index) => ({ path: `file${index}.bin`, name: `file${index}.bin`, kind: 'file' as const, size: 10 - index, mtime: 1_700_000_000_000 })),
    ]
    const files = entries.filter(entry => entry.kind === 'file')
    stub.respond('browseDirectory', () => ok({ entries, total: entries.length }))
    stub.respond('listLargeFiles', () => ok({ files, total: 20 }))
    const view = await renderReady(stub)
    expect(node(view, '[data-disk-dirs-more]')?.textContent).toContain('共 12 个')
    expect(node(view, '[data-disk-files-more]')?.textContent).toContain('8 个文件')
    expect(node(view, '[data-disk-treemap-more]')?.textContent).toContain('共 20 项')
  })
})

describe('scan lifecycle', () => {
  it('starts from Enter, shows progress, polls twice and loads the completed result; the button rescans', async () => {
    const completed = scanFixture()
    const stub = makeCall({
      listScans: () => ok({ scans: [] }),
      listTrash: () => ok({ entries: [] }),
      browseDirectory: () => ok(rootEntries()),
      listLargeFiles: () => ok({ files: [] }),
      listDuplicateGroups: () => ok(groupList()),
      startScan: () => ok({ scan: runningScan() }),
    })
    stub.once('readScan', () => ok({ scan: runningScan() }))
    stub.once('readScan', () => ok({ scan: completed }))
    const view = await renderReady(stub)

    fireEvent.change(node(view, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })
    fireEvent.keyDown(node(view, '[data-disk-path-input]')!, { key: 'a' })
    expect(stub.calls.some(call => call.op === 'startScan')).toBe(false)
    fireEvent.keyDown(node(view, '[data-disk-path-input]')!, { key: 'Enter' })
    await flush()
    expect(stub.calls.some(call => call.op === 'startScan')).toBe(true)
    expect(node(view, '[data-disk-scan-progress]')?.getAttribute('data-disk-state')).toBe('running')
    expect(node(view, '[data-disk-progress-path]')?.textContent).toContain('Code')
    expect(node(view, '[data-disk-scan]')?.textContent).toBe(zh['view.scanning'])

    await advance(400)
    expect(stub.calls.filter(call => call.op === 'readScan')).toHaveLength(1)
    expect(node(view, '[data-disk-scan-progress]')).toBeTruthy()
    await advance(400)
    expect(stub.calls.filter(call => call.op === 'readScan')).toHaveLength(2)
    expect(node(view, '[data-disk-scan-progress]')).toBeNull()
    expect(node(view, '[data-disk-summary-total]')).toBeTruthy()

    // The same control is the explicit rescan path; a scan that is already
    // complete loads its details without waiting for a poll.
    const browseCalls = stub.calls.filter(call => call.op === 'browseDirectory').length
    stub.respond('startScan', () => ok({ scan: completed }))
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(stub.calls.filter(call => call.op === 'startScan')).toHaveLength(2)
    expect(stub.calls.filter(call => call.op === 'browseDirectory').length).toBe(browseCalls + 1)
  })

  it('reports a refused cancellation', async () => {
    const stub = makeCall({
      listScans: () => ok({ scans: [] }),
      listTrash: () => ok({ entries: [] }),
      startScan: () => ok({ scan: runningScan() }),
      cancelScan: () => failed('cancel refused'),
    })
    const view = await renderReady(stub)
    fireEvent.change(node(view, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    fireEvent.click(node(view, '[data-disk-cancel]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('cancel refused')
  })

  it('cancels a running scan through its operation', async () => {
    const stub = makeCall({
      listScans: () => ok({ scans: [] }),
      listTrash: () => ok({ entries: [] }),
      startScan: () => ok({ scan: runningScan() }),
      cancelScan: () => ok({ cancelled: true, scan: scanFixture({ state: 'cancelled', endedAt: 2 }) }),
    })
    const view = await renderReady(stub)
    fireEvent.change(node(view, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    fireEvent.click(node(view, '[data-disk-cancel]')!)
    await flush()
    expect(stub.calls.find(call => call.op === 'cancelScan')?.args.scanId).toBe('s_1')
    expect(node(view, '[data-disk-scan-progress]')).toBeNull()
  })
})

describe('scan failures', () => {
  it('rejects an empty path before calling the host', async () => {
    const stub = emptyStub()
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(stub.calls.some(call => call.op === 'startScan')).toBe(false)
    expect(node(view, '[data-disk-error]')?.textContent).toBe(zh['view.notice.emptyPath'])
  })

  it('shows failed, malformed, rejected and unarrived start results', async () => {
    const stub = emptyStub()
    const view = await renderReady(stub)
    fireEvent.change(node(view, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })

    stub.once('startScan', () => failed('permission denied'))
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('permission denied')

    stub.once('startScan', () => ok({ scan: null }))
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toBe(zh['view.error.malformed'])

    stub.once('startScan', () => rejected('denied', 'not allowed'))
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('not allowed')

    stub.once('startScan', () => { throw new Error('carrier dropped') })
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('carrier dropped')
  })

  it('reports malformed and failed poll results', async () => {
    const stub = makeCall({
      listScans: () => ok({ scans: [] }),
      listTrash: () => ok({ entries: [] }),
      startScan: () => ok({ scan: runningScan() }),
    })
    stub.once('readScan', () => ok({ scan: null }))
    const view = await renderReady(stub)
    fireEvent.change(node(view, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    await advance(400)
    expect(node(view, '[data-disk-error]')?.textContent).toBe(zh['view.error.malformed'])

    cleanup()
    const second = makeCall({
      listScans: () => ok({ scans: [] }),
      listTrash: () => ok({ entries: [] }),
      startScan: () => ok({ scan: runningScan() }),
    })
    second.once('readScan', () => failed('poll refused'))
    const secondView = await renderReady(second)
    fireEvent.change(node(secondView, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })
    fireEvent.click(node(secondView, '[data-disk-scan]')!)
    await flush()
    await advance(400)
    expect(node(secondView, '[data-disk-error]')?.textContent).toContain('poll refused')
    second.respond('readScan', () => ok({ scan: runningScan() }))
    fireEvent.click(node(secondView, '[data-disk-poll-retry]')!)
    await flush()
    expect(second.calls.filter(call => call.op === 'readScan').length).toBeGreaterThan(1)
  })

  it('sends the chosen exclusion and filesystem options with a scan', async () => {
    const stub = makeCall({
      listScans: () => ok({ scans: [] }),
      listTrash: () => ok({ entries: [] }),
      startScan: () => ok({ scan: scanFixture() }),
    })
    const view = await renderReady(stub)
    fireEvent.change(node(view, '[data-disk-path-input]')!, { target: { value: '/srv/data' } })
    fireEvent.click(node(view, '[data-disk-options-toggle]')!)
    expect(node(view, '[data-disk-options]')).toBeTruthy()
    fireEvent.click(node(view, '[data-disk-exclude-common]')!)
    fireEvent.click(node(view, '[data-disk-cross-filesystems]')!)
    fireEvent.click(node(view, '[data-disk-scan]')!)
    await flush()
    expect(stub.calls.find(call => call.op === 'startScan')?.args).toEqual({ dir: '/srv/data', crossFileSystems: true })
    fireEvent.click(node(view, '[data-disk-options-toggle]')!)
    expect(node(view, '[data-disk-options]')).toBeNull()
  })
})

describe('duplicate analysis', () => {
  it('analyzes, cancels, selects/deselects and stages the redundant copies', async () => {
    const stub = happyCalls()
    stub.respond('startDuplicateAnalysis', () => ok({ scan: { ...scanFixture(), duplicateState: 'running', duplicate: null } }))
    stub.respond('cancelScan', () => ok({ cancelled: true, scan: { ...scanFixture(), duplicateState: 'cancelled' } }))
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-tab="duplicates"]')!)
    expect(nodes(view, '[data-disk-dup-group]')).toHaveLength(2)
    expect(node(view, '[data-disk-duplicates]')?.textContent).toContain('100 B')

    stub.respond('startDuplicateAnalysis', () => ok({ scan: { ...scanFixture(), duplicateState: 'running', duplicate: null } }))
    fireEvent.click(node(view, '[data-disk-analyze]')!)
    await flush()
    expect(node(view, '[data-disk-dup-running]')).toBeTruthy()
    fireEvent.click(node(view, '[data-disk-dup-cancel]')!)
    await flush()
    expect(stub.calls.some(call => call.op === 'cancelScan')).toBe(true)

    stub.respond('stageEntries', () => ok({ staged: trashList().entries.slice(0, 1) }))
    const checkbox = node(view, '[data-disk-dup-checkbox="g_1"]') as HTMLInputElement
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    fireEvent.click(node(view, '[data-disk-stage]')!)
    fireEvent.click(document.querySelector('[role="dialog"] button[aria-label="关闭"]')!)
    expect(document.querySelector('[data-disk-stage-confirm]')).toBeNull()
    fireEvent.click(node(view, '[data-disk-stage]')!)
    fireEvent.click(Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === '取消')!)
    expect(stub.calls.some(call => call.op === 'stageEntries')).toBe(false)
    fireEvent.click(node(view, '[data-disk-stage]')!)
    fireEvent.click(document.querySelector('[data-disk-stage-confirm]')!)
    await flush()
    const stage = stub.calls.find(call => call.op === 'stageEntries')
    expect(stage?.args.paths).toEqual(['Docs/a.bin'])
    expect(node(view, '[data-disk-notice]')?.textContent).toContain('1')
  })

  it('explains an empty selection and surfaces stage failures/cancellation', async () => {
    const stub = happyCalls()
    stub.respond('listDuplicateGroups', () => ok({ groups: [{ groupId: 'g_1', hash: 'h', size: 5, paths: [], wastedBytes: 0 }], total: 1, wastedBytes: 0 }))
    stub.respond('stageEntries', () => failed('permission denied'))
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-tab="duplicates"]')!)
    fireEvent.click(node(view, '[data-disk-dup-checkbox="g_1"]')!)
    fireEvent.click(node(view, '[data-disk-stage]')!)
    await flush()
    expect(node(view, '[data-disk-notice]')?.textContent).toBe(zh['view.duplicates.noneSelected'])

    cleanup()
    const failing = happyCalls()
    failing.respond('stageEntries', () => failed('permission denied'))
    const second = await renderReady(failing)
    fireEvent.click(node(second, '[data-disk-tab="duplicates"]')!)
    fireEvent.click(node(second, '[data-disk-dup-checkbox="g_1"]')!)
    fireEvent.click(node(second, '[data-disk-stage]')!)
    fireEvent.click(document.querySelector('[data-disk-stage-confirm]')!)
    await flush()
    expect(node(second, '[data-disk-error]')?.textContent).toContain('permission denied')

    failing.respond('stageEntries', () => cancelled())
    fireEvent.click(node(second, '[data-disk-stage]')!)
    fireEvent.click(document.querySelector('[data-disk-stage-confirm]')!)
    await flush()
    expect(node(second, '[data-disk-error]')?.textContent).toBe(zh['view.error.cancelled'])
  })

  it('renders the duplicate failed/cancelled states and malformed start result', async () => {
    const stub = happyCalls()
    stub.respond('listDuplicateGroups', () => ok({ groups: [], total: 0, wastedBytes: 0 }))
    stub.respond('startDuplicateAnalysis', () => ok({ scan: null }))
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-tab="duplicates"]')!)
    fireEvent.click(node(view, '[data-disk-analyze]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toBe(zh['view.error.malformed'])

    stub.respond('startDuplicateAnalysis', () => failed('analysis refused'))
    fireEvent.click(node(view, '[data-disk-analyze]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('analysis refused')

    cleanup()
    const failedScan = scanFixture({ duplicateState: 'failed', duplicate: null })
    const second = await renderReady(happyCalls(failedScan))
    fireEvent.click(node(second, '[data-disk-tab="duplicates"]')!)
    expect(node(second, '[data-disk-dup-failed]')?.textContent).toBe(zh['view.duplicates.state.failed'])

    cleanup()
    const cancelledScan = scanFixture({ duplicateState: 'cancelled', duplicate: null })
    const third = await renderReady(happyCalls(cancelledScan))
    fireEvent.click(node(third, '[data-disk-tab="duplicates"]')!)
    expect(node(third, '[data-disk-dup-cancelled]')?.textContent).toBe(zh['view.duplicates.state.cancelled'])
  })
})

describe('trash', () => {
  it('lists, restores and permanently deletes entries, refreshing after each write', async () => {
    let trashCalls = 0
    const stub = makeCall({
      listScans: () => ok({ scans: [scanFixture()] }),
      listTrash: () => {
        trashCalls += 1
        if (trashCalls <= 2) return ok(trashList())
        if (trashCalls === 3) return ok({ entries: [trashList().entries[1]] })
        return ok({ entries: [] })
      },
      browseDirectory: () => ok(rootEntries()),
      listLargeFiles: () => ok(largeFiles()),
      listDuplicateGroups: () => ok(groupList()),
      restoreTrash: () => ok({ restored: { id: 't_1', path: 'Code/a.bin' } }),
      purgeTrash: () => ok({ purged: true }),
    })
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-tab="trash"]')!)
    expect(nodes(view, '[data-disk-trash-row]')).toHaveLength(2)
    expect(node(view, '[data-disk-trash-summary]')?.textContent).toContain('2 项')

    fireEvent.click(node(view, '[data-disk-restore="t_1"]')!)
    await flush()
    expect(stub.calls.some(call => call.op === 'restoreTrash')).toBe(true)
    expect(node(view, '[data-disk-notice]')?.textContent).toContain('Code/a.bin')
    expect(nodes(view, '[data-disk-trash-row]')).toHaveLength(1)

    // A permanent delete needs the explicit second click.
    fireEvent.click(node(view, '[data-disk-purge="t_2"]')!)
    await flush()
    expect(stub.calls.some(call => call.op === 'purgeTrash')).toBe(false)
    expect(node(view, '[data-disk-purge="t_2"]')?.textContent).toBe(zh['view.trash.confirm'])
    fireEvent.click(node(view, '[data-disk-purge="t_2"]')!)
    await flush()
    expect(stub.calls.some(call => call.op === 'purgeTrash')).toBe(true)
    expect(node(view, '[data-disk-notice]')?.textContent).toBe(zh['view.notice.purged'])
    expect(node(view, '[data-disk-trash-empty]')).toBeTruthy()
  })

  it('surfaces restore/purge failures', async () => {
    const stub = happyCalls()
    stub.respond('restoreTrash', () => failed('restore-conflict'))
    stub.respond('purgeTrash', () => failed('purge-failed'))
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-tab="trash"]')!)
    fireEvent.click(node(view, '[data-disk-restore="t_1"]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('restore-conflict')
    fireEvent.click(node(view, '[data-disk-purge="t_2"]')!)
    fireEvent.click(node(view, '[data-disk-purge="t_2"]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('purge-failed')
  })
})

describe('scan history', () => {
  it('opens a selected past scan and reports its root', async () => {
    const first = scanFixture({ scanId: 's_1', root: '/srv/one' })
    const second = scanFixture({ scanId: 's_2', root: '/srv/two' })
    const stub = makeCall({
      listScans: () => ok({ scans: [first, second] }),
      listTrash: () => ok({ entries: [] }),
      browseDirectory: () => ok(rootEntries()),
      listLargeFiles: () => ok(largeFiles()),
      listDuplicateGroups: () => ok(groupList()),
      readScan: () => ok({ scan: second }),
    })
    const view = await renderReady(stub)
    expect(node(view, '[data-disk-root]')?.textContent).toBe('/srv/one')
    fireEvent.click(node(view, '[data-disk-history]')!)
    expect(nodes(view, '[data-disk-history-item]')).toHaveLength(2)
    fireEvent.click(node(view, '[data-disk-history-item="s_2"]')!)
    await flush()
    expect(stub.calls.find(call => call.op === 'readScan')?.args.scanId).toBe('s_2')
    expect(node(view, '[data-disk-root]')?.textContent).toBe('/srv/two')
    expect(node(view, '[data-disk-history-panel]')).toBeNull()
  })

  it('reports failed and malformed history reads', async () => {
    const stub = happyCalls()
    stub.respond('readScan', () => failed('gone'))
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-history]')!)
    fireEvent.click(node(view, '[data-disk-history-item="s_1"]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toContain('gone')

    stub.respond('readScan', () => ok({ scan: null }))
    fireEvent.click(node(view, '[data-disk-history]')!)
    fireEvent.click(node(view, '[data-disk-history-item="s_1"]')!)
    await flush()
    expect(node(view, '[data-disk-error]')?.textContent).toBe(zh['view.error.malformed'])
  })
})

describe('directory picker', () => {
  it('adopts the host-returned path', async () => {
    const stub = emptyStub()
    const view = await renderReady(stub, { pickDirectory: async () => '/picked/dir' })
    fireEvent.click(node(view, '[data-disk-pick]')!)
    await flush()
    expect((node(view, '[data-disk-path-input]') as HTMLInputElement).value).toBe('/picked/dir')
  })

  it('keeps the path input when the deployment serves no picker or the user cancels', async () => {
    const stub = emptyStub()
    const view = await renderReady(stub)
    fireEvent.click(node(view, '[data-disk-pick]')!)
    await flush()
    expect(node(view, '[data-disk-notice]')?.textContent).toBe(zh['view.notice.pickerUnavailable'])

    cleanup()
    const cancelling = await renderReady(stub, { pickDirectory: async () => undefined })
    fireEvent.click(node(cancelling, '[data-disk-pick]')!)
    await flush()
    expect(node(cancelling, '[data-disk-notice]')?.textContent).toBe(zh['view.notice.pickerUnavailable'])

    cleanup()
    const failing = await renderReady(stub, { pickDirectory: async () => { throw new Error('picker crashed') } })
    fireEvent.click(node(failing, '[data-disk-pick]')!)
    await flush()
    expect(node(failing, '[data-disk-error]')?.textContent).toContain('picker crashed')
  })
})

describe('change subscription and failures', () => {
  it('re-reads the current scan when the shell announces a change', async () => {
    const changed = makeChanged()
    const stub = happyCalls()
    await renderReady(stub, { changed })
    const before = stub.calls.filter(call => call.op === 'readScan').length
    changed.fire()
    await flush()
    expect(stub.calls.filter(call => call.op === 'readScan').length).toBe(before + 1)
  })

  it('surfaces rejected/cancelled/unarrived reads and each detail failure', async () => {
    const rejecting = makeCall({ listScans: () => rejected('denied', 'not allowed') })
    const first = await renderReady(rejecting)
    expect(node(first, '[data-disk-error]')?.textContent).toContain('not allowed')

    cleanup()
    const cancelledCall = makeCall({ listScans: () => cancelled() })
    const second = await renderReady(cancelledCall)
    expect(node(second, '[data-disk-error]')?.textContent).toBe(zh['view.error.cancelled'])

    cleanup()
    const throwing = makeCall({ listScans: () => { throw new Error('carrier dropped') } })
    const third = await renderReady(throwing)
    expect(node(third, '[data-disk-error]')?.textContent).toContain('carrier dropped')

    for (const op of ['browseDirectory', 'listLargeFiles', 'listDuplicateGroups'] as const) {
      cleanup()
      const stub = happyCalls()
      stub.respond(op, () => failed(`${op} failed`))
      const view = await renderReady(stub)
      expect(node(view, '[data-disk-error]')?.textContent).toContain(`${op} failed`)
    }
  })

  it('switches through every tab', async () => {
    const view = await renderReady(happyCalls())
    fireEvent.click(node(view, '[data-disk-tab="duplicates"]')!)
    expect(node(view, '[data-disk-tab-panel="duplicates"]')).toBeTruthy()
    fireEvent.click(node(view, '[data-disk-tab="trash"]')!)
    expect(node(view, '[data-disk-tab-panel="trash"]')).toBeTruthy()
    fireEvent.click(node(view, '[data-disk-tab="browse"]')!)
    expect(node(view, '[data-disk-tab-panel="browse"]')).toBeTruthy()
  })

  it('renders the English dictionary through the same page', async () => {
    const view = await renderReady(happyCalls(), { t: translator(en) })
    expect(node(view, '[data-disk-summary-total]')?.textContent).toContain('Total size')
    expect(node(view, '[data-disk-tab="browse"]')?.textContent).toContain('Browse')
  })
})
