import { describe, expect, it } from 'vitest'
import { AppError, ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { AppDeclaration, CapabilityGrant, GrantStorePort, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import {
  activityFrom, appendActivity, cardFailure, cardFailureKindOf, emptyDocument, HOME_SCHEMA_VERSION, HomeApp, homeDeclaration,
  MAX_CARD_FAILURE_CODE, MAX_CARD_FAILURE_MESSAGE,
} from '../src/index.ts'
import { HomeRepository } from '../src/index.ts'
import type { HomeStorePort, Overview } from '../src/index.ts'

const at = '2026-01-01T00:00:00.000Z'

/** One in-memory document namespace; the repository only needs get/put. */
function memoryStore(): HomeStorePort {
  const docs = new Map<string, { value: unknown; revision: number }>()
  const row = <T>(scope: string): { value: T; revision: number; schemaVersion: number; updatedAt: number } | undefined => {
    const stored = docs.get(scope)
    return stored === undefined ? undefined : { value: stored.value as T, revision: stored.revision, schemaVersion: HOME_SCHEMA_VERSION, updatedAt: 0 }
  }
  return {
    documents: {
      get: async <T>(scope: string) => row<T>(scope),
      put: async <T>(scope: string, value: T) => {
        const revision = (docs.get(scope)?.revision ?? 0) + 1
        docs.set(scope, { value, revision })
        return { value, revision, schemaVersion: HOME_SCHEMA_VERSION, updatedAt: 0 }
      },
    },
  }
}

/** A grant store holding one table. */
function grantStore(grants: CapabilityGrant[]): GrantStorePort {
  const state = { grants: [...grants] }
  return { list: async () => [...state.grants], save: async (next) => { state.grants = [...next] } }
}

/** The inbox peer: one event and one list read. */
function inboxPeer(): AppDeclaration {
  return {
    id: 'inbox', name: 'Inbox', description: 'publisher', version: '1.0.0',
    events: { 'entry.created': { description: 'new entries were written', subscription: 'open' } },
    ops: {
      listEntries: {
        description: 'list entries', params: {}, result: { type: 'json' }, effect: 'read',
        exposure: { peers: 'open' },
        execute: () => ({
          entries: [
            { id: 'e_2', title: 'Second', fetchedAt: 20 },
            { id: 'e_1', title: 'First', fetchedAt: 10 },
          ],
          total: 2,
          counts: { unseen: 2, unread: 3, saved: 1, all: 2 },
        }),
      },
    },
  }
}


/** The inbox peer that supports the grouped read (one entry per source preview). */
function groupedInboxPeer(): AppDeclaration {
  const base = inboxPeer()
  return {
    ...base,
    ops: {
      ...base.ops,
      listGroups: {
        description: 'grouped entries', params: {}, result: { type: 'json' }, effect: 'read',
        exposure: { peers: 'open' },
        execute: () => ({
          groups: [
            { sourceId: 's1', name: 'One', kind: 'rss', removed: false, enabled: true, total: 2, unread: 2, latestAt: 30, hasMore: true, entries: [{ id: 'e_3', title: 'Third', fetchedAt: 30 }, { id: 'e_4', title: 'Fourth', fetchedAt: 25 }] },
            { sourceId: 's2', name: 'Two', kind: 'rss', removed: false, enabled: true, total: 1, unread: 1, latestAt: 20, hasMore: false, entries: [{ id: 'e_5', title: 'Fifth', fetchedAt: 20 }] },
          ],
          total: 3,
          filteredUnread: 3,
          totalGroups: 2,
          counts: { unseen: 2, unread: 3, saved: 1, all: 2 },
        }),
      },
    },
  }
}

/** The todo peer: a list the dashboard counts itself. */
function todoPeer(): AppDeclaration {
  return {
    id: 'todo', name: 'Todo', description: 'peer', version: '1.0.0',
    ops: {
      listTasks: {
        description: 'list tasks', params: {}, result: { type: 'json' }, effect: 'read',
        exposure: { peers: 'open' },
        execute: () => [
          { id: 't_1', title: 'Due today', dueDate: TODAY, completedAt: null },
          { id: 't_2', title: 'Overdue', dueDate: YESTERDAY, completedAt: null },
          { id: 't_3', title: 'Someday', dueDate: null, completedAt: null },
          { id: 't_4', title: 'Done', dueDate: null, completedAt: 5 },
        ],
      },
    },
  }
}

/** The notes peer: two summaries, newest first. */
function notesPeer(): AppDeclaration {
  return {
    id: 'notes', name: 'Notes', description: 'peer', version: '1.0.0',
    ops: {
      list: {
        description: 'list notes', params: {}, result: { type: 'json' }, effect: 'read',
        exposure: { peers: 'open' },
        execute: () => [
          { id: 'n_2', title: 'Newer', updatedAt: 20 },
          { id: 'n_1', title: 'Older', updatedAt: 10 },
        ],
      },
    },
  }
}

/** One peer operation that refuses with the given error. */
function refusingOp(error: unknown): AppDeclaration['ops'][string] {
  return {
    description: 'refuse', params: {}, result: { type: 'json' }, effect: 'read',
    exposure: { peers: 'open' },
    execute: () => { throw error },
  }
}

const NOW = Date.parse('2026-01-15T10:00:00Z')
const TODAY = '2026-01-15'
const YESTERDAY = '2026-01-14'

/** One mounted home application over a memory store. */
async function mountHome(peers: readonly AppDeclaration[], grants: CapabilityGrant[] = []): Promise<{
  runtime: ApplicationRuntime
  repository: HomeRepository
}> {
  const runtime = new ApplicationRuntime({ grants: grantStore(grants), now: () => new Date(NOW) })
  for (const peer of peers) await runtime.register(peer)
  const repository = new HomeRepository(memoryStore())
  const app = new HomeApp({ repository, now: () => NOW })
  await runtime.register(homeDeclaration(app))
  return { runtime, repository }
}

/** Let the asynchronous listener finish its write. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}

describe('home overview', () => {
  it('uses the grouped read for a source-diverse inbox preview', async () => {
    const { runtime } = await mountHome([groupedInboxPeer(), todoPeer(), notesPeer()])
    const outcome = await runtime.call({ kind: 'human' }, 'home', 'overview', {})
    expect(outcome).toMatchObject({ status: 'success' })
    const overview = outcome.result as unknown as Overview
    expect(overview.inbox).toMatchObject({ available: true, unseen: 2, unread: 3, saved: 1 })
    expect(overview.inbox.recent?.map(entry => entry.title)).toEqual(['Third', 'Fifth', 'Fourth'])
  })
  it('degrades one card instead of failing the whole read', async () => {
    const { runtime } = await mountHome([notesPeer()])
    const outcome = await runtime.call({ kind: 'human' }, 'home', 'overview', {})
    expect(outcome).toMatchObject({ status: 'success' })
    const overview = outcome.result as unknown as Overview
    expect(overview.inbox).toMatchObject({ available: false, failure: { kind: 'other', code: 'platform.unknown-app' } })
    expect(overview.todo).toMatchObject({ available: false, failure: { kind: 'other' } })
    expect(overview.notes).toMatchObject({ available: true, total: 2 })
  })

  it('keeps a bounded reason on every refused card and distinguishes the kinds', async () => {
    const stack = `${'x'.repeat(240)}\n    at /srv/internal/home.ts:42:7`
    const inbox: AppDeclaration = {
      id: 'inbox', name: 'Inbox', description: 'peer', version: '1.0.0',
      // Home subscribes to this event at start; a publisher without it would
      // fail the subscription and take the whole dashboard down.
      events: { 'entry.created': { description: 'new entries were written', subscription: 'open' } },
      ops: { listGroups: refusingOp(new AppError('capability-not-approved', 'the user has not approved the storage capability for this application')) },
    }
    const todo: AppDeclaration = {
      id: 'todo', name: 'Todo', description: 'peer', version: '1.0.0',
      ops: { listTasks: refusingOp(new AppError('capability-undeclared', 'this application never declared the storage capability')) },
    }
    const notes: AppDeclaration = {
      id: 'notes', name: 'Notes', description: 'peer', version: '1.0.0',
      ops: { list: refusingOp(new AppError('boom', stack)) },
    }
    const { runtime } = await mountHome([inbox, todo, notes])
    const outcome = await runtime.call({ kind: 'human' }, 'home', 'overview', {})
    expect(outcome).toMatchObject({ status: 'success' })
    const overview = outcome.result as unknown as Overview
    expect(overview.inbox).toMatchObject({
      available: false,
      failure: { kind: 'not-approved', code: 'app.capability-not-approved', message: 'the user has not approved the storage capability for this application' },
    })
    expect(overview.todo).toMatchObject({
      available: false,
      failure: { kind: 'undeclared', code: 'app.capability-undeclared' },
    })
    expect(overview.notes).toMatchObject({ available: false, failure: { kind: 'other', code: 'app.boom' } })
    const message = overview.notes.failure?.message ?? ''
    expect(message).toHaveLength(MAX_CARD_FAILURE_MESSAGE)
    expect(message).not.toContain('\n')
    expect(message).not.toContain('internal/home.ts')
  })

  it('treats an unanswerable peer outcome as a broken carrier', async () => {
    const app = new HomeApp({ repository: new HomeRepository(memoryStore()), now: () => NOW })
    const ctx = {
      call: async () => ({ callId: 'call-1', status: 'unknown' }),
    } as unknown as OperationContext
    const overview = await app.overview(ctx)
    expect(overview.inbox).toEqual({ available: false, failure: { kind: 'transport' } })
    expect(overview.notes).toEqual({ available: false, failure: { kind: 'transport' } })
  })

  it('reports a rejected peer call as a broken carrier, not its error text', async () => {
    const app = new HomeApp({ repository: new HomeRepository(memoryStore()), now: () => NOW })
    const ctx = {
      call: async () => { throw new Error('socket closed\n    at /secret/path') },
    } as unknown as OperationContext
    const overview = await app.overview(ctx)
    expect(overview.inbox).toEqual({ available: false, failure: { kind: 'transport' } })
    expect(overview.todo).toEqual({ available: false, failure: { kind: 'transport' } })
    expect(overview.notes).toEqual({ available: false, failure: { kind: 'transport' } })
  })
})

describe('home card failure vocabulary', () => {
  it('classifies the known wire codes and keeps everything else bounded', () => {
    expect(cardFailureKindOf('app.capability-not-approved')).toBe('not-approved')
    expect(cardFailureKindOf('app.capability-undeclared')).toBe('undeclared')
    expect(cardFailureKindOf('platform.not-open-to-caller')).toBe('not-open')
    expect(cardFailureKindOf('platform.caller-not-declared')).toBe('caller-not-declared')
    expect(cardFailureKindOf('platform.denied')).toBe('denied')
    expect(cardFailureKindOf('platform.confirmation-declined')).toBe('confirmation')
    expect(cardFailureKindOf('platform.confirmation-unavailable')).toBe('confirmation')
    expect(cardFailureKindOf('app.business-code')).toBe('other')
    expect(cardFailureKindOf(undefined)).toBe('other')
    const failure = cardFailure(`platform.${'c'.repeat(100)}`, 'first line\nsecond line')
    expect(failure.code).toHaveLength(MAX_CARD_FAILURE_CODE)
    expect(failure.message).toBe('first line')
    expect(cardFailure(undefined, '   ')).toEqual({ kind: 'other' })
  })
})

describe('home activity', () => {
  it('records a received notice and announces the change', async () => {
    const grants: CapabilityGrant[] = [{
      caller: { kind: 'app', appId: 'home' },
      capabilities: ['event:inbox#entry.created'],
      grantedAt: at,
    }]
    const notices: string[] = []
    const { runtime } = await mountHome([inboxPeer()], grants)
    runtime.onChange((notice) => { notices.push(notice.appId) })
    runtime.publishEvent('inbox', 'entry.created', [{ appId: 'inbox', type: 'entry', id: 'e_1' }])
    await settle()
    const outcome = await runtime.call({ kind: 'human' }, 'home', 'activity', {})
    expect(outcome).toMatchObject({ status: 'success' })
    const activity = outcome.result as unknown as { activities: Array<Record<string, unknown>> }
    expect(activity.activities).toHaveLength(1)
    expect(activity.activities[0]).toMatchObject({ appId: 'inbox', type: 'entry.created', count: 1, refs: [{ type: 'entry', id: 'e_1' }] })
    expect(notices).toContain('home')
  })

  it('subscribes before the publisher is installed', async () => {
    const grants: CapabilityGrant[] = [{
      caller: { kind: 'app', appId: 'home' },
      capabilities: ['event:inbox#entry.created'],
      grantedAt: at,
    }]
    const runtime = new ApplicationRuntime({ grants: grantStore(grants), now: () => new Date(NOW) })
    const repository = new HomeRepository(memoryStore())
    await runtime.register(homeDeclaration(new HomeApp({ repository, now: () => NOW })))
    await runtime.register(inboxPeer())
    runtime.publishEvent('inbox', 'entry.created', [{ appId: 'inbox', type: 'entry', id: 'e_9' }])
    await settle()
    const outcome = await runtime.call({ kind: 'human' }, 'home', 'activity', {})
    const activity = outcome.result as unknown as { activities: Array<Record<string, unknown>> }
    expect(activity.activities.map(entry => entry['count'])).toEqual([1])
  })

  it('keeps the newest batches and ignores a repeated event id', () => {
    let document = emptyDocument()
    for (let index = 0; index < 7; index += 1) {
      document = appendActivity(document, activityFrom('inbox', 'entry.created', `event-${String(index)}`, index, [{ type: 'entry', id: `e_${String(index)}` }]))
    }
    expect(document.activities).toHaveLength(5)
    expect(document.activities[0]?.id).toBe('event-6')
    const repeated = activityFrom('inbox', 'entry.created', 'event-6', 99, [])
    expect(appendActivity(document, repeated)).toBe(document)
  })
})
