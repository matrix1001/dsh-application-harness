// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { apply as applyNode } from '../src/index.ts'
import { apply as applyClient, inject } from '../src/client/index.ts'
import { en, type NotesKey, zh } from '../src/client/locales.ts'

describe('notes-view plugin', () => {
  it('mounts nothing on the host side', () => {
    expect(applyNode()).toBeUndefined()
  })

  it('registers both dictionaries and the notes page', () => {
    const effects: Array<() => unknown> = []
    const register = vi.fn()
    const bind = vi.fn(() => (key: NotesKey) => zh[key])
    const registerView = vi.fn()
    const ctx = {
      effect: (effect: () => unknown) => { effects.push(effect); return () => undefined },
      locale: { register, bind },
      applicationViews: { register: registerView },
    }

    applyClient(ctx as never)
    expect(inject).toEqual(['locale', 'applicationViews'])
    expect(effects).toHaveLength(2)
    for (const effect of effects) effect()
    expect(register).toHaveBeenCalledWith('notes', { zh, en })
    expect(registerView).toHaveBeenCalledTimes(1)

    const [appId, view] = registerView.mock.calls[0] as unknown as [string, {
      name: () => string
      description: () => string
      tone: string
      icon: (input: { size: number }) => unknown
      contentLayout: string
      Component: (props: unknown) => unknown
    }]
    expect(appId).toBe('notes')
    expect(view.name()).toBe('笔记')
    expect(view.description()).toBe('本地笔记、标签与检索。')
    expect(view.tone).toBe('neutral')
    expect(view.icon({ size: 16 })).toBeTruthy()
    expect(view.contentLayout).toBe('fill')
    expect(view.Component({})).toBeTruthy()
  })
})
