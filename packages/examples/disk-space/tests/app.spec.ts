/**
 * The declaration and the row. The declaration test drives every operation
 * through its declared `execute` (the same face the runtime calls), so its
 * parameter/result/openness metadata and the thin service delegates are both
 * covered; the row test mounts the plugin through the runtime's own
 * `mountApplication` contract and proves the index path default and disposal.
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import type { Context } from '@deepseek-ai/cordis'
import { DISK_SPACE_APP_ID, DISK_SPACE_SCHEMA_VERSION, diskSpaceDeclaration } from '../src/app.ts'
import { DiskSpaceService } from '../src/service.ts'
import { apply } from '../src/index.ts'
import { makeContext, putFile, removeTree, settleTasks, tempDir } from './helpers.ts'

let root: string
let workDir: string
let service: DiskSpaceService
let declaration: AppDeclaration

beforeEach(async () => {
  root = await tempDir('dsh-disk-space-app-')
  workDir = await tempDir('dsh-disk-space-app-db-')
  service = new DiskSpaceService(join(workDir, 'index.db'))
  declaration = diskSpaceDeclaration(service)
})

afterEach(async () => {
  service.close()
  await removeTree(root)
  await removeTree(workDir)
})

/** Call one declared operation's execute face. */
async function run(op: string, args: unknown, ctx: OperationContext): Promise<unknown> {
  const operation = declaration.ops[op]
  if (operation === undefined) throw new Error(`missing op ${op}`)
  return await operation.execute(args as never, ctx)
}

describe('declaration', () => {
  it('declares its identity, durable data and capabilities', () => {
    expect(declaration.id).toBe(DISK_SPACE_APP_ID)
    expect(declaration.generation).toBe(2)
    expect(declaration.data).toEqual({ kind: 'own-sqlite', path: 'disk-space/index.db', schemaVersion: DISK_SPACE_SCHEMA_VERSION, backup: 'exclude' })
    expect(declaration.capabilities).toEqual(['storage'])
    expect(Object.keys(declaration.ops).sort()).toEqual([
      'browseDirectory', 'cancelScan', 'listDuplicateGroups', 'listLargeFiles', 'listScans', 'listTrash',
      'purgeTrash', 'readScan', 'restoreTrash', 'stageEntries', 'startDuplicateAnalysis', 'startScan',
    ])
    expect(declaration.ops.purgeTrash?.exposure).toEqual({ ai: 'closed', peers: 'closed' })
    expect(declaration.ops.startScan?.exposure).toEqual({ ai: 'confirm', peers: 'open' })
    expect(declaration.ops.readScan?.effect).toBe('read')
    expect(declaration.ops.listTrash?.effect).toBe('read')
  })

  it('drives the full scan → browse → duplicates → trash flow through the declared operations', async () => {
    await putFile(join(root, 'a.txt'), 'same-content')
    await putFile(join(root, 'b.txt'), 'same-content')
    await putFile(join(root, 'c.txt'), 'other')
    const context = makeContext()

    const started = await run('startScan', { dir: root }, context.ctx) as { scan: { scanId: string; state: string } }
    expect(started.scan.state).toBe('running')
    await settleTasks(context)
    const scanId = started.scan.scanId
    expect((await run('readScan', { scanId }, context.ctx) as { scan: { state: string } }).scan.state).toBe('completed')
    expect((await run('listScans', {}, context.ctx) as { scans: unknown[] }).scans).toHaveLength(1)
    expect((await run('browseDirectory', { scanId }, context.ctx) as { total: number }).total).toBe(3)
    expect((await run('listLargeFiles', { scanId }, context.ctx) as { total: number }).total).toBe(3)

    await run('startDuplicateAnalysis', { scanId }, context.ctx)
    await settleTasks(context)
    const groups = await run('listDuplicateGroups', { scanId }, context.ctx) as { groups: unknown[]; wastedBytes: number }
    expect(groups.groups).toHaveLength(1)
    expect(groups.wastedBytes).toBe(12)

    const staged = await run('stageEntries', { scanId, paths: ['b.txt'] }, context.ctx) as { staged: Array<{ id: string }> }
    expect(staged.staged).toHaveLength(1)
    expect((await run('listTrash', {}, context.ctx) as { entries: unknown[] }).entries).toHaveLength(1)
    await run('restoreTrash', { id: staged.staged[0]!.id }, context.ctx)
    const stagedAgain = await run('stageEntries', { scanId, paths: ['b.txt'] }, context.ctx) as { staged: Array<{ id: string }> }
    expect(await run('purgeTrash', { id: stagedAgain.staged[0]!.id }, context.ctx)).toEqual({ purged: true })
  })

  it('cancels through the declared cancel operation', async () => {
    await putFile(join(root, 'a.txt'), 'a')
    const context = makeContext()
    const started = await run('startScan', { dir: root }, context.ctx) as { scan: { scanId: string } }
    const cancel = await run('cancelScan', { scanId: started.scan.scanId }, context.ctx) as { cancelled: boolean }
    expect(cancel.cancelled).toBe(true)
    await settleTasks(context)
  })
})

/** The runtime face `mountApplication` needs (a real registry owns the production one). */
interface MountStub {
  ctx: Context
  mounted: AppDeclaration[]
  effects: Array<() => unknown>
  warnings: string[]
}

/** Build a Cordis-shaped context with just the faces the row touches. */
function mountStub(): MountStub {
  const mounted: AppDeclaration[] = []
  const effects: Array<() => unknown> = []
  const warnings: string[] = []
  const ctx = {
    applications: {
      mount: (mountedDeclaration: AppDeclaration) => {
        mounted.push(mountedDeclaration)
        return {}
      },
      stop: async () => 'stopped',
      unregister: () => true,
    },
    effect: (callback: () => unknown) => {
      effects.push(callback)
      return () => {}
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  } as unknown as Context
  return { ctx, mounted, effects, warnings }
}

describe('row', () => {
  it('mounts the declaration over an explicit database path and closes it on unload', async () => {
    const stub = mountStub()
    const explicit = join(workDir, 'explicit.db')
    await apply(stub.ctx, { databasePath: explicit })
    expect(stub.mounted.map(app => app.id)).toEqual([DISK_SPACE_APP_ID])
    await access(explicit)
    // The row owns two effects: its own close disposer and the runtime unload.
    expect(stub.effects).toHaveLength(2)
    const dispose = stub.effects[0]!() as () => void
    dispose()
    await stub.effects[1]!()
    expect(stub.warnings).toEqual([])
  })

  it('defaults to the harness home path when no config is given', async () => {
    const home = await tempDir('dsh-disk-space-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const stub = mountStub()
      await apply(stub.ctx)
      expect(stub.mounted).toHaveLength(1)
      await access(join(home, 'application-harness', 'disk-space', 'index.db'))
      await stub.effects[0]!()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await removeTree(home)
    }
  })
})
