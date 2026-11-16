// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { apply as applyNode } from '../src/index.ts'
import { apply as applyClient, inject } from '../src/client/index.ts'
import { en, type TasksKey, zh } from '../src/client/locales.ts'

describe('tasks-view plugin', () => {
  it('mounts nothing on the host side', () => {
    expect(applyNode()).toBeUndefined()
  })

  it('registers both dictionaries and the tasks page', () => {
    const effects: Array<() => unknown> = []
    const register = vi.fn()
    const bind = vi.fn(() => (key: TasksKey) => zh[key])
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
    expect(register).toHaveBeenCalledWith('tasks', { zh, en })
    expect(registerView).toHaveBeenCalledTimes(1)

    const [appId, view] = registerView.mock.calls[0] as unknown as [string, {
      name: () => string
      description: () => string
      contentLayout: string
      Component: (props: unknown) => unknown
    }]
    expect(appId).toBe('tasks')
    expect(view.name()).toBe('任务')
    expect(view.description()).toBe('项目、任务、截止日与今天。')
    expect(view.contentLayout).toBe('fill')
    expect(view.Component({})).toBeTruthy()
  })
})
