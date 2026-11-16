// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { zh } from '../src/client/locales.ts'

describe('inbox view plugin', () => {
  it('registers the inbox page and dictionaries', () => {
    const register = vi.fn()
    const dictionary = vi.fn()
    const ctx = {
      locale: { register: dictionary, bind: () => (key: string) => key },
      applicationViews: { register },
      effect: (fn: () => unknown) => { fn(); return vi.fn() },
    } as unknown as Context
    apply(ctx)
    expect(dictionary).toHaveBeenCalledWith('inbox', { zh, en: expect.any(Object) })
    expect(register).toHaveBeenCalledWith('inbox', expect.objectContaining({ contentLayout: 'fill' }))
    const view = register.mock.calls[0]![1] as { name: () => string; description: () => string; Component: (props: never) => unknown }
    expect(view.name()).toBe('app.name')
    expect(view.description()).toBe('app.description')
    expect(view.Component({} as never)).toBeTruthy()
  })

  it('host half has no behavior', () => {
    expect(hostApply()).toBeUndefined()
  })
})
