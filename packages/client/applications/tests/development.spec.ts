import { describe, expect, it, vi } from 'vitest'
import { createDevelopmentSession } from '../src/client/development.ts'

function faces(overrides: Partial<Parameters<typeof createDevelopmentSession>[0]> = {}): Parameters<typeof createDevelopmentSession>[0] {
  return {
    sessions: { create: vi.fn(async () => 's-dev'), retain: vi.fn() },
    workspaces: { create: vi.fn(async ({ path }) => ({ workspaceId: 'w-dev', path })) },
    remote: { registerDevelopmentSession: vi.fn(async () => ({ ok: true as const, value: true })) },
    ...overrides,
  } as never
}

describe('createDevelopmentSession', () => {
  it('creates a workspace, session and host binding', async () => {
    const options = faces()
    await expect(createDevelopmentSession(options, 'notes', ' /src ')).resolves.toBe('s-dev')
    expect(options.workspaces!.create).toHaveBeenCalledWith({ path: '/src' })
    expect(options.sessions.create).toHaveBeenCalledWith({ workspaceId: 'w-dev', cwd: '/src', agentPreset: 'standard' })
    expect(options.remote.registerDevelopmentSession).toHaveBeenCalledWith('s-dev', 'notes')
  })

  it('rejects missing input, workspace, remote and binding', async () => {
    await expect(createDevelopmentSession(faces(), 'notes', ' ')).rejects.toThrow(/path is empty/u)
    await expect(createDevelopmentSession(faces({ workspaces: undefined }), 'notes', '/src')).rejects.toThrow(/workspace controller/u)
    await expect(createDevelopmentSession(faces({ remote: {} }), 'notes', '/src')).rejects.toThrow(/unavailable in this deployment/u)
    const refused = faces({ remote: { registerDevelopmentSession: vi.fn(async () => ({ ok: true as const, value: false })) } })
    await expect(createDevelopmentSession(refused, 'notes', '/src')).rejects.toThrow(/refused/u)
    const broken = faces({ workspaces: { create: vi.fn(async () => { throw new Error('no dir') }) } })
    await expect(createDevelopmentSession(broken, 'notes', '/src')).rejects.toThrow(/no dir/u)
  })
})
