/**
 * The application area's dedicated conversation target: first-use setup creates
 * a Workspace + Session, remembers the pair, marks the Session for the scoped
 * tool face, and clears a target whose Session disappeared. This is the binding
 * layer the pane and the tool scope rely on; no renderer is involved.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createAppConversation,
  type AppConversationPage,
  type AppConversationPreferences,
} from '../src/client/app-conversation.ts'
import type { ApplicationPreferences } from '../src/client/preferences.ts'
import type { ConversationSession } from '../src/client/conversation-session.ts'

function preferences(): AppConversationPreferences & { value: ApplicationPreferences } {
  let value: ApplicationPreferences = {}
  return {
    get value() { return value },
    getSnapshot: () => value,
    set: next => { value = next },
  }
}

function session(): ConversationSession {
  return { release: vi.fn() }
}

describe('application conversation target', () => {
  it('has no target before first-use setup and never borrows a main Session', async () => {
    const sessions = { create: vi.fn(), retain: vi.fn() }
    const service = createAppConversation({
      sessions,
      workspaces: undefined,
      remote: {},
      preferences: preferences(),
    })
    expect(service.target()).toBeUndefined()
    await expect(service.open()).resolves.toBeUndefined()
    expect(sessions.retain).not.toHaveBeenCalled()
  })

  it('creates the dedicated Workspace and Session, remembers them, marks the Session and retains it', async () => {
    const prefs = preferences()
    const page: AppConversationPage = { appId: 'workbook', label: 'Workbook · 任务', record: { kind: 'task', id: 't1' } }
    const retained = session()
    const sessions = {
      create: vi.fn(async () => 's-app'),
      retain: vi.fn(() => retained),
    }
    const workspaces = {
      create: vi.fn(async () => ({ workspaceId: 'w-app', path: '/home/u/dsh-workspaces/app-conversation/p' })),
    }
    const remote = {
      registerAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
      setAppConversationContext: vi.fn(async () => ({ ok: true as const, value: true })),
      prepareAppConversationWorkspace: vi.fn(async () => ({ ok: true as const, value: '/prepared/app-conversation' })),
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })

    // The browser may report a page before setup finishes; setup must flush it.
    await service.setPage(page)
    const reference = await service.setup(' /home/u/dsh-workspaces/app-conversation/p ')

    expect(reference).toBe(retained)
    expect(remote.prepareAppConversationWorkspace).toHaveBeenCalledWith('/home/u/dsh-workspaces/app-conversation/p')
    expect(workspaces.create).toHaveBeenCalledWith({ path: '/prepared/app-conversation' })
    expect(sessions.create).toHaveBeenCalledWith({
      workspaceId: 'w-app',
      cwd: '/home/u/dsh-workspaces/app-conversation/p',
      agentPreset: 'standard',
    })
    expect(prefs.value.appConversation).toEqual({ workspaceId: 'w-app', sessionId: 's-app' })
    expect(remote.registerAppConversation).toHaveBeenCalledWith('s-app')
    expect(remote.setAppConversationContext).toHaveBeenCalledWith('s-app', page)
    expect(service.target()).toEqual({ workspaceId: 'w-app', sessionId: 's-app' })

    // The visible chip can detach the page: the host pointer is cleared, and a
    // page change while detached stays detached until the chip is turned on.
    remote.setAppConversationContext.mockClear()
    await service.setContextEnabled(false)
    expect(remote.setAppConversationContext).toHaveBeenLastCalledWith('s-app', null)
    await service.setPage({ ...page, label: 'Workbook · 项目' })
    expect(remote.setAppConversationContext).toHaveBeenLastCalledWith('s-app', null)
    await service.setContextEnabled(true)
    expect(remote.setAppConversationContext).toHaveBeenLastCalledWith('s-app', { ...page, label: 'Workbook · 项目' })
  })

  it('reopens the remembered Session, marks it again and flushes the current page', async () => {
    const prefs = preferences()
    prefs.set({ appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
    const retained = session()
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(() => retained),
    }
    const remote = {
      registerAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
      setAppConversationContext: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces: undefined, remote, preferences: prefs })
    const page: AppConversationPage = { appId: 'disk-analysis', label: 'Disk analysis' }
    await service.setPage(page)
    const reference = await service.open()

    expect(reference).toBe(retained)
    expect(sessions.retain).toHaveBeenCalledWith('s-app', { source: 'applicationHarnessConversation', facets: { conversation: true } })
    expect(remote.registerAppConversation).toHaveBeenCalledWith('s-app')
    expect(remote.setAppConversationContext).toHaveBeenCalledWith('s-app', page)
  })

  it('does not reopen an archived remembered conversation and returns to first-use setup', async () => {
    const prefs = preferences()
    prefs.set({ appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
    const sessions = { create: vi.fn(), retain: vi.fn(() => session()) }
    const remote = { clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })) }
    const workspaces = {
      create: vi.fn(),
      list: { getSnapshot: () => ({ archivedSessionIds: ['s-app'] }) },
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    expect(service.targets()).toEqual([])
    await expect(service.open()).resolves.toBeUndefined()
    expect(sessions.retain).not.toHaveBeenCalled()
    expect(remote.clearAppConversation).not.toHaveBeenCalled()
    expect(prefs.value.appConversation).toBeUndefined()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w-app', sessionId: 's-app' }])
  })

  it('opens the next live conversation when the remembered one was archived', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w-app', sessionId: 's-archived' },
      appConversations: [
        { workspaceId: 'w-app', sessionId: 's-archived' },
        { workspaceId: 'w-app', sessionId: 's-live' },
      ],
    })
    const retained = session()
    const sessions = { create: vi.fn(), retain: vi.fn(() => retained) }
    const remote = { clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })) }
    const workspaces = {
      create: vi.fn(),
      list: { getSnapshot: () => ({ archivedSessionIds: ['s-archived'] }) },
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await expect(service.open()).resolves.toBe(retained)
    expect(sessions.retain).toHaveBeenCalledWith('s-live', { source: 'applicationHarnessConversation', facets: { conversation: true } })
    expect(remote.clearAppConversation).not.toHaveBeenCalled()
    expect(service.target()?.sessionId).toBe('s-live')
  })

  it('skips an archived target when selecting and keeps the live target', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w-app', sessionId: 's-live' },
      appConversations: [
        { workspaceId: 'w-app', sessionId: 's-live' },
        { workspaceId: 'w-app', sessionId: 's-archived' },
      ],
    })
    const retained = session()
    const sessions = { create: vi.fn(), retain: vi.fn(() => retained) }
    const remote = { clearAppConversation: vi.fn(async () => { throw new Error('host unavailable') }) }
    const workspaces = {
      create: vi.fn(),
      list: { getSnapshot: () => ({ archivedSessionIds: ['s-archived'] }) },
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await expect(service.select('s-archived')).resolves.toBeUndefined()
    expect(remote.clearAppConversation).not.toHaveBeenCalled()
    expect(service.targets().map(target => target.sessionId)).toEqual(['s-live'])
    expect(service.target()?.sessionId).toBe('s-live')
  })

  it('creates a new conversation from the next live target when the active one is archived', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w-app', sessionId: 's-app' },
      appConversations: [
        { workspaceId: 'w-app', sessionId: 's-app' },
        { workspaceId: 'w-app', sessionId: 's-live' },
      ],
    })
    const sessions = { create: vi.fn(async () => 's-new'), retain: vi.fn(() => session()) }
    const remote = { clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })) }
    const workspaces = {
      create: vi.fn(),
      list: { getSnapshot: () => ({ archivedSessionIds: ['s-app'] }) },
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.create()
    expect(sessions.create).toHaveBeenCalledWith({ workspaceId: 'w-app', agentPreset: 'standard' })
    expect(service.target()?.sessionId).toBe('s-new')
    expect(service.targets().map(target => target.sessionId)).toEqual(['s-live', 's-new'])
    expect(prefs.value.appConversations).toContainEqual({ workspaceId: 'w-app', sessionId: 's-app' })
    expect(remote.clearAppConversation).not.toHaveBeenCalled()
  })

  it('forgets a target whose Session no longer retains', async () => {
    const prefs = preferences()
    prefs.set({ appConversation: { workspaceId: 'w-app', sessionId: 'gone' } })
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(() => { throw new Error('session is gone') }),
    }
    const clearAppConversation = vi.fn(async () => { throw new Error('host is gone') })
    const service = createAppConversation({ sessions, workspaces: undefined, remote: { clearAppConversation }, preferences: prefs })
    await expect(service.open()).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(clearAppConversation).toHaveBeenCalled()
    expect(prefs.value.appConversation).toBeUndefined()
  })

  it('opens a remembered target when no scoped bridge is mounted at all', async () => {
    const prefs = preferences()
    prefs.set({ appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
    const retained = session()
    const sessions = { create: vi.fn(), retain: vi.fn(() => retained) }
    const service = createAppConversation({ sessions, workspaces: undefined, remote: {}, preferences: prefs })
    await expect(service.open()).resolves.toBe(retained)
  })

  it('survives a missing scoped bridge and a failed context report', async () => {
    const prefs = preferences()
    prefs.set({ appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
    const sessions = { create: vi.fn(), retain: vi.fn(() => session()) }
    const remote = {
      registerAppConversation: vi.fn(async () => { throw new Error('bridge unavailable') }),
      setAppConversationContext: vi.fn(async () => { throw new Error('context unavailable') }),
    }
    const service = createAppConversation({ sessions, workspaces: undefined, remote, preferences: prefs })
    await expect(service.open()).resolves.toBeDefined()
    await expect(service.setPage({ appId: 'workbook', label: 'Workbook' })).resolves.toBeUndefined()
  })

  it('forgets a half-made target when the Session cannot be retained after setup', async () => {
    const prefs = preferences()
    const sessions = {
      create: vi.fn(async () => 's-app'),
      retain: vi.fn(() => { throw new Error('cannot bind') }),
    }
    const workspaces = { create: vi.fn(async () => ({ workspaceId: 'w-app', path: '/tmp/ws' })) }
    const service = createAppConversation({ sessions, workspaces, remote: {}, preferences: prefs })
    await expect(service.setup('/tmp/ws')).rejects.toThrow(/cannot bind/u)
    expect(prefs.value.appConversation).toBeUndefined()
  })

  it('forgets a selected conversation when its Session cannot be retained', async () => {
    const prefs = preferences()
    const sessions = { create: vi.fn(async () => 's-1'), retain: vi.fn(() => { throw new Error('gone') }) }
    const workspaces = { create: vi.fn(async () => ({ workspaceId: 'w', path: '/tmp/ws' })) }
    const service = createAppConversation({ sessions, workspaces, remote: {}, preferences: prefs })
    await expect(service.setup('/tmp/ws')).rejects.toThrow(/gone/u)
    expect(service.target()).toBeUndefined()
  })

  it('creates and selects more than one application conversation in the same workspace', async () => {
    const prefs = preferences()
    let serial = 0
    const sessions = {
      create: vi.fn(async () => `s-${String(++serial)}`),
      retain: vi.fn(() => session()),
    }
    const workspaces = { create: vi.fn(async () => ({ workspaceId: 'w-app', path: '/tmp/ws' })) }
    const remote = { registerAppConversation: vi.fn(async () => ({ ok: true as const, value: true })), setAppConversationContext: vi.fn(async () => ({ ok: true as const, value: true })) }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.setup('/tmp/ws')
    await service.create()
    expect(service.targets().map(target => target.sessionId)).toEqual(['s-1', 's-2'])
    expect(service.target()?.sessionId).toBe('s-2')
    await service.select('s-1')
    expect(service.target()?.sessionId).toBe('s-1')
    await expect(service.select('missing')).resolves.toBeUndefined()
    const bare = createAppConversation({ sessions, workspaces: undefined, remote: {}, preferences: preferences() })
    await expect(bare.create()).rejects.toThrow(/not been set up/u)
  })

  it('reports a workspace directory that cannot be prepared before registering it', async () => {
    const prefs = preferences()
    const workspaces = { create: vi.fn(async () => ({ workspaceId: 'w-app', path: '/prepared' })) }
    const remote = { prepareAppConversationWorkspace: vi.fn(async () => ({ ok: false as const })) }
    const service = createAppConversation({ sessions: { create: vi.fn(), retain: vi.fn() }, workspaces, remote, preferences: prefs })
    await expect(service.setup('/missing/path')).rejects.toThrow(/could not be prepared/u)
    expect(workspaces.create).not.toHaveBeenCalled()
    expect(prefs.value.appConversation).toBeUndefined()
  })

  it('requires a workspace controller and a non-empty path for setup', async () => {
    const service = createAppConversation({
      sessions: { create: vi.fn(), retain: vi.fn() },
      workspaces: undefined,
      remote: {},
      preferences: preferences(),
    })
    await expect(service.setup('   ')).rejects.toThrow(/empty/u)
    await expect(service.setup('/tmp/ws')).rejects.toThrow(/workspace controller/u)
  })

  it('restores host-marked Sessions, hides archived ones and clears deleted targets', async () => {
    const prefs = preferences()
    prefs.set({
      appConversations: [
        { workspaceId: 'w-old', sessionId: 's-deleted' },
        { workspaceId: 'w-app', sessionId: 's-archived' },
      ],
    })
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(),
      list: { getSnapshot: () => ({ byId: { 's-host': { sessionId: 's-host' }, 's-archived': { sessionId: 's-archived' } } }) },
    }
    const workspaces = {
      create: vi.fn(),
      list: {
        getSnapshot: () => ({
          archivedSessionIds: ['s-archived'],
          workspaces: [
            { workspaceId: 'w-host', sessionIds: ['s-host'] },
            { workspaceId: 'w-app', sessionIds: ['s-archived'] },
          ],
        }),
      },
    }
    const remote = {
      appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-host', 's-deleted'] })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([
      { workspaceId: 'w-host', sessionId: 's-host' },
      { workspaceId: 'w-app', sessionId: 's-archived' },
    ])
    expect(service.targets()).toEqual([{ workspaceId: 'w-host', sessionId: 's-host' }])
    expect(service.target()?.sessionId).toBe('s-host')
    expect(remote.clearAppConversation).toHaveBeenCalledWith('s-deleted')
    expect(remote.clearAppConversation).not.toHaveBeenCalledWith('s-archived')
  })

  it('does not keep a Session the host refuses to register', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w-app', sessionId: 's-app' },
      appConversations: [{ workspaceId: 'w-app', sessionId: 's-app' }],
    })
    const sessions = {
      create: vi.fn(async () => 's-new'),
      retain: vi.fn(() => session()),
      list: { getSnapshot: () => ({ byId: { 's-app': { sessionId: 's-app' } } }) },
    }
    const remote = {
      registerAppConversation: vi.fn(async () => ({ ok: true as const, value: false })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces: undefined, remote, preferences: prefs })
    await expect(service.create()).rejects.toThrow(/refused/u)
    expect(service.select).toBeTypeOf('function')
    await expect(service.select('s-app')).resolves.toBeUndefined()
    expect(remote.clearAppConversation).toHaveBeenCalled()
    await expect(service.open()).resolves.toBeUndefined()
  })

  it('reconciles host-marked Sessions without dropping remembered ones', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w-keep', sessionId: 's-keep' },
      appConversations: [{ workspaceId: 'w-keep', sessionId: 's-keep' }],
    })
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(),
      list: {
        getSnapshot: () => ({
          byId: {
            's-keep': { sessionId: 's-keep' },
            's-host': { sessionId: 's-host' },
            's-archived': { sessionId: 's-archived' },
          },
        }),
      },
    }
    const workspaces = {
      create: vi.fn(),
      list: {
        getSnapshot: () => ({
          archivedSessionIds: ['s-archived'],
          workspaces: [
            { workspaceId: 'w-host', sessionIds: ['s-host'] },
            { workspaceId: 'w-archived', sessionIds: ['s-archived'] },
          ],
        }),
      },
    }
    const remote = {
      appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-host', 's-archived', 's-missing'] })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([
      { workspaceId: 'w-host', sessionId: 's-host' },
      { workspaceId: 'w-archived', sessionId: 's-archived' },
      { workspaceId: 'w-keep', sessionId: 's-keep' },
    ])
    expect(service.target()?.sessionId).toBe('s-keep')
    expect(remote.clearAppConversation).toHaveBeenCalledWith('s-missing')
    expect(remote.clearAppConversation).not.toHaveBeenCalledWith('s-keep')
  })

  it('resolves a restored Workspace from the byId snapshot and skips an unknown one', async () => {
    const prefs = preferences()
    prefs.set({})
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(),
      list: { getSnapshot: () => ({ byId: { 's-by': { sessionId: 's-by' }, 's-loose': { sessionId: 's-loose' } } }) },
    }
    const workspaces = {
      create: vi.fn(),
      list: {
        getSnapshot: () => ({
          archivedSessionIds: [],
          byId: { 'w-by': { workspaceId: 'w-by', sessionIds: ['s-by'] } },
        }),
      },
    }
    const remote = {
      appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-by', 's-loose'] })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w-by', sessionId: 's-by' }])
  })

  it('merges the host list when the platform session list is not readable', async () => {
    const prefs = preferences()
    prefs.set({})
    const sessions = { create: vi.fn(), retain: vi.fn() }
    const workspaces = {
      create: vi.fn(),
      list: { getSnapshot: () => ({ archivedSessionIds: [], workspaces: [{ workspaceId: 'w-host', sessionIds: ['s-host'] }] }) },
    }
    const remote = {
      appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-host'] })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w-host', sessionId: 's-host' }])
    expect(remote.clearAppConversation).not.toHaveBeenCalled()
  })

  it('removes a remembered target the host lists but the platform no longer has', async () => {
    const prefs = preferences()
    prefs.set({ appConversations: [{ workspaceId: 'w', sessionId: 's-gone' }] })
    const sessions = { create: vi.fn(), retain: vi.fn(), list: { getSnapshot: () => ({ byId: {} }) } }
    const remote = {
      appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-gone'] })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces: undefined, remote, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([])
    expect(service.target()).toBeUndefined()
    expect(remote.clearAppConversation).toHaveBeenCalledWith('s-gone')
  })

  it('switches the active target to a surviving one when the old one is deleted', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w', sessionId: 's-gone' },
      appConversations: [
        { workspaceId: 'w', sessionId: 's-gone' },
        { workspaceId: 'w-live', sessionId: 's-live' },
      ],
    })
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(),
      list: { getSnapshot: () => ({ byId: { 's-live': { sessionId: 's-live' } } }) },
    }
    const remote = {
      appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-live', 's-gone'] })),
      clearAppConversation: vi.fn(async () => ({ ok: true as const, value: true })),
    }
    const service = createAppConversation({ sessions, workspaces: undefined, remote, preferences: prefs })
    await service.reconcile()
    expect(service.target()).toEqual({ workspaceId: 'w-live', sessionId: 's-live' })
    expect(service.targets()).toEqual([{ workspaceId: 'w-live', sessionId: 's-live' }])
  })

  it('keeps a known target workspace when the snapshot only names the workspace', async () => {
    const prefs = preferences()
    prefs.set({ appConversations: [{ workspaceId: 'w-known', sessionId: 's-known' }] })
    const sessions = {
      create: vi.fn(),
      retain: vi.fn(),
      list: { getSnapshot: () => ({ byId: { 's-known': { sessionId: 's-known' } } }) },
    }
    const workspaces = {
      create: vi.fn(),
      list: { getSnapshot: () => ({ byId: { 'w-known': { workspaceId: 'w-known' } } }) },
    }
    const remote = { appConversations: vi.fn(async () => ({ ok: true as const, value: ['s-known'] })) }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w-known', sessionId: 's-known' }])
  })

  it('does nothing without the host list command', async () => {
    const prefs = preferences()
    prefs.set({ appConversations: [{ workspaceId: 'w', sessionId: 's-1' }] })
    const sessions = { create: vi.fn(), retain: vi.fn(), list: { getSnapshot: () => ({ byId: { 's-1': { sessionId: 's-1' } } }) } }
    const service = createAppConversation({ sessions, workspaces: undefined, remote: {}, preferences: prefs })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w', sessionId: 's-1' }])
  })

  it('keeps remembered targets when the host list cannot be read', async () => {
    const prefs = preferences()
    prefs.set({ appConversations: [{ workspaceId: 'w', sessionId: 's-1' }] })
    const sessions = { create: vi.fn(), retain: vi.fn(), list: { getSnapshot: () => ({ byId: { 's-1': { sessionId: 's-1' } } }) } }
    const service = createAppConversation({
      sessions,
      workspaces: undefined,
      remote: { appConversations: async () => ({ ok: false }) },
      preferences: prefs,
    })
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w', sessionId: 's-1' }])
  })

  it('opens no target when every remembered conversation is archived', async () => {
    const prefs = preferences()
    prefs.set({
      appConversation: { workspaceId: 'w', sessionId: 's-archived' },
      appConversations: [{ workspaceId: 'w', sessionId: 's-archived' }],
    })
    const sessions = { create: vi.fn(), retain: vi.fn(() => session()) }
    const remote = { clearAppConversation: vi.fn() }
    const workspaces = { create: vi.fn(), list: { getSnapshot: () => ({ archivedSessionIds: ['s-archived'] }) } }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await expect(service.create()).rejects.toThrow(/archived/u)
    await expect(service.open()).resolves.toBeUndefined()
    expect(remote.clearAppConversation).not.toHaveBeenCalled()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w', sessionId: 's-archived' }])
  })

  it('ignores a context switch without a target and a previous target without a session list', async () => {
    const prefs = preferences()
    prefs.set({ appConversations: [{ workspaceId: 'w', sessionId: 's-1' }] })
    const sessions = { create: vi.fn(), retain: vi.fn() }
    const service = createAppConversation({
      sessions,
      workspaces: undefined,
      remote: { appConversations: async () => ({ ok: true, value: [] }) },
      preferences: prefs,
    })
    await expect(service.setContextEnabled(false)).resolves.toBeUndefined()
    await service.reconcile()
    expect(prefs.value.appConversations).toEqual([{ workspaceId: 'w', sessionId: 's-1' }])
  })

  it('fails setup when the host refuses to register the Session', async () => {
    const prefs = preferences()
    const sessions = { create: vi.fn(async () => 's-app'), retain: vi.fn(() => session()) }
    const workspaces = { create: vi.fn(async () => ({ workspaceId: 'w-app', path: '/tmp/ws' })) }
    const remote = { registerAppConversation: vi.fn(async () => ({ ok: true as const, value: false })) }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })
    await expect(service.setup('/tmp/ws')).rejects.toThrow(/refused/u)
    expect(prefs.value.appConversation).toBeUndefined()
  })
})
