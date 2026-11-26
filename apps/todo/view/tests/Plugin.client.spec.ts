// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { apply as applyNode } from '../src/index.ts'
import { apply as applyClient, inject } from '../src/client/index.ts'
import { en, type TodoKey, zh } from '../src/client/locales.ts'

describe('todo-view plugin', () => {
  it('mounts nothing on the host side', () => {
    expect(applyNode()).toBeUndefined()
  })

  it('registers both dictionaries and the todo page', () => {
    const effects: Array<() => unknown> = []
    const register = vi.fn()
    const bind = vi.fn(() => (key: TodoKey) => zh[key])
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
    expect(register).toHaveBeenCalledWith('todo', { zh, en })
    expect(registerView).toHaveBeenCalledTimes(1)

    const [appId, view] = registerView.mock.calls[0] as unknown as [string, {
      name: () => string
      description: () => string
      contentLayout: string
      Component: (props: unknown) => unknown
    }]
    expect(appId).toBe('todo')
    expect(view.name()).toBe('待办')
    expect(view.description()).toBe('待办、截止日与优先级。')
    expect(view.contentLayout).toBe('fill')
    expect(view.Component({})).toBeTruthy()
  })
})
