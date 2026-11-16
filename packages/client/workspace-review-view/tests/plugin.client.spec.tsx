// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
import { apply, inject } from '../src/client/index.ts'
import * as nodeHalf from '../src/index.ts'
import { makeCall, props, translator } from './view-harness.tsx'

describe('workspace-review view registration', () => {
  it('has a no-op host half so the row can load', () => {
    expect(nodeHalf.apply()).toBeUndefined()
  })

  it('registers the dictionaries and the fill page under the app id', () => {
    const registrations: Array<{ appId: string; view: ApplicationView }> = []
    const register = vi.fn((appId: string, view: ApplicationView) => {
      registrations.push({ appId, view })
      return () => undefined
    })
    const dictionaryRegister = vi.fn(() => () => undefined)
    const disposers: Array<() => void> = []
    const ctx = {
      effect: (fn: () => unknown) => {
        const result = fn()
        if (typeof result === 'function') disposers.push(result as () => void)
        return () => undefined
      },
      locale: {
        register: dictionaryRegister,
        bind: () => translator(),
      },
      applicationViews: { register },
    }
    apply(ctx as never)
    expect(inject).toEqual(['locale', 'applicationViews'])
    expect(dictionaryRegister).toHaveBeenCalledWith('workspace-review', expect.objectContaining({ zh: expect.any(Object), en: expect.any(Object) }))
    expect(register).toHaveBeenCalledTimes(1)
    expect(registrations[0]?.appId).toBe('workspace-review')
    const view = registrations[0]!.view
    expect(view.contentLayout).toBe('fill')
    expect(view.tone).toBe('business')
    expect(typeof view.name === 'function' ? view.name() : view.name).toBe('工作区回顾')
    expect(typeof view.description === 'function' ? view.description() : view.description).toContain('DSH')
    expect(view.icon?.({ size: 16 })).toBeTruthy()
    const element = view.Component?.(props(makeCall().call))
    expect(element).toBeTruthy()
    for (const dispose of disposers) dispose()
  })
})
