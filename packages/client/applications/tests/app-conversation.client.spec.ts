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
  let value: ApplicationPreferences = { navExpanded: true, navOrder: [] }
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
    }
    const service = createAppConversation({ sessions, workspaces, remote, preferences: prefs })

    // The browser may report a page before setup finishes; setup must flush it.
    await service.setPage(page)
    const reference = await service.setup(' /home/u/dsh-workspaces/app-conversation/p ')

    expect(reference).toBe(retained)
    expect(workspaces.create).toHaveBeenCalledWith({ path: '/home/u/dsh-workspaces/app-conversation/p' })
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
    prefs.set({ navExpanded: true, navOrder: [], appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
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
    expect(sessions.retain).toHaveBeenCalledWith('s-app', { source: 'applicationHarnessConversation' })
    expect(remote.registerAppConversation).toHaveBeenCalledWith('s-app')
    expect(remote.setAppConversationContext).toHaveBeenCalledWith('s-app', page)
  })

  it('forgets a target whose Session no longer retains', async () => {
    const prefs = preferences()
    prefs.set({ navExpanded: true, navOrder: [], appConversation: { workspaceId: 'w-app', sessionId: 'gone' } })
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
    prefs.set({ navExpanded: true, navOrder: [], appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
    const retained = session()
    const sessions = { create: vi.fn(), retain: vi.fn(() => retained) }
    const service = createAppConversation({ sessions, workspaces: undefined, remote: {}, preferences: prefs })
    await expect(service.open()).resolves.toBe(retained)
  })

  it('survives a missing scoped bridge and a failed context report', async () => {
    const prefs = preferences()
    prefs.set({ navExpanded: true, navOrder: [], appConversation: { workspaceId: 'w-app', sessionId: 's-app' } })
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
})
