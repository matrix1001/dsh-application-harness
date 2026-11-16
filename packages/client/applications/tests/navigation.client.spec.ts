import { describe, expect, it } from 'vitest'
import { createAppNavigation } from '../src/client/navigation.ts'
import type { NavigationLocation } from '../src/client/navigation.ts'

function fakeHost(initial: NavigationLocation) {
  let current: NavigationLocation | undefined = initial
  const selected: string[] = []
  return {
    selected,
    host: {
      currentAppId: () => current?.appId,
      currentLocation: () => current,
      select: (appId: string) => {
        selected.push(appId)
        current = { appId }
      },
    },
    move: (location: NavigationLocation) => { current = location },
  }
}

const tick = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }

describe('app navigation', () => {
  it('opens a target, remembers the origin and returns to it', async () => {
    const f = fakeHost({ appId: 'tasks', record: { appId: 'tasks', kind: 'task', id: 't1' }, view: 'detail' })
    const navigation = createAppNavigation(f.host)
    navigation.open({ appId: 'notes', record: { appId: 'notes', kind: 'note', id: 'n1' } })
    await tick()
    expect(f.selected).toEqual(['notes'])
    expect(navigation.state.getSnapshot()).toMatchObject({ canBack: true, backAppId: 'tasks' })
    expect(navigation.state.getSnapshot().route).toMatchObject({
      appId: 'notes', record: { appId: 'notes', kind: 'note', id: 'n1' },
    })
    navigation.back()
    await tick()
    expect(f.selected).toEqual(['notes', 'tasks'])
    expect(navigation.state.getSnapshot().route).toMatchObject({
      appId: 'tasks', record: { appId: 'tasks', kind: 'task', id: 't1' }, view: 'detail',
    })
    expect(navigation.state.getSnapshot().canBack).toBe(false)
  })

  it('blocks open and back when the current page guard refuses', async () => {
    const f = fakeHost({ appId: 'tasks' })
    const navigation = createAppNavigation(f.host)
    navigation.registerGuard('tasks', () => false)
    navigation.open({ appId: 'notes' })
    await tick()
    expect(f.selected).toEqual([])
    navigation.open({ appId: 'notes' })
    await tick()
    navigation.registerGuard('tasks', () => true)
    navigation.open({ appId: 'notes' })
    await tick()
    expect(f.selected).toEqual(['notes'])
    navigation.registerGuard('notes', () => false)
    navigation.back()
    await tick()
    expect(f.selected).toEqual(['notes'])
  })

  it('treats a throwing or rejecting guard as refusal', async () => {
    const f = fakeHost({ appId: 'tasks' })
    const navigation = createAppNavigation(f.host)
    navigation.registerGuard('tasks', () => { throw new Error('nope') })
    navigation.open({ appId: 'notes' })
    await tick()
    expect(f.selected).toEqual([])
    navigation.registerGuard('tasks', async () => { throw new Error('nope') })
    navigation.open({ appId: 'notes' })
    await tick()
    expect(f.selected).toEqual([])
  })

  it('clears the stack on direct navigation and unregisters guards exactly', async () => {
    const f = fakeHost({ appId: 'tasks' })
    const navigation = createAppNavigation(f.host)
    const dispose = navigation.registerGuard('tasks', () => true)
    navigation.open({ appId: 'notes' })
    await tick()
    navigation.clear()
    expect(navigation.state.getSnapshot()).toEqual({ canBack: false })
    dispose()
    navigation.back()
    await tick()
    expect(f.selected).toEqual(['notes'])
  })

  it('caps the remembered origins', async () => {
    const f = fakeHost({ appId: 'a' })
    const navigation = createAppNavigation(f.host)
    for (let index = 0; index < 25; index += 1) {
      f.move({ appId: `app-${String(index)}` })
      navigation.open({ appId: `next-${String(index)}` })
      await tick()
    }
    expect(navigation.state.getSnapshot().canBack).toBe(true)
  })
})

describe('direct application switch', () => {
  it('consults the current page guard before switching and clears the stack after it passes', async () => {
    const f = fakeHost({ appId: 'tasks' })
    const navigation = createAppNavigation(f.host)
    navigation.open({ appId: 'notes' })
    await tick()
    navigation.registerGuard('notes', () => false)
    expect(await navigation.select('tasks')).toBe(false)
    expect(f.selected).toEqual(['notes'])
    navigation.registerGuard('notes', () => true)
    expect(await navigation.select('tasks')).toBe(true)
    expect(f.selected).toEqual(['notes', 'tasks'])
    expect(navigation.state.getSnapshot().canBack).toBe(false)
  })
})

describe('navigation edge cases', () => {
  it('handles no current location, a missing guard, cleared stacks and stale disposers', async () => {
    const f = fakeHost({ appId: 'tasks' })
    const navigation = createAppNavigation({ ...f.host, currentAppId: () => undefined, currentLocation: () => undefined })
    navigation.open({ appId: 'notes' })
    await tick()
    expect(f.selected).toEqual(['notes'])
    navigation.back()
    await tick()
    expect(navigation.state.getSnapshot().canBack).toBe(false)

    const g = fakeHost({ appId: 'tasks' })
    const nav = createAppNavigation(g.host)
    const first = nav.registerGuard('tasks', () => true)
    const second = nav.registerGuard('tasks', () => false)
    first()
    nav.open({ appId: 'notes' })
    await tick()
    expect(g.selected).toEqual([])
    second()
    nav.open({ appId: 'notes' })
    await tick()
    expect(g.selected).toEqual(['notes'])
  })
})

describe('navigation nested back', () => {
  it('retains a back target when the stack still has one', async () => {
    const f = fakeHost({ appId: 'tasks' })
    const nav = createAppNavigation(f.host)
    nav.open({ appId: 'notes' })
    await tick()
    nav.open({ appId: 'calendar' })
    await tick()
    nav.back()
    await tick()
    expect(nav.state.getSnapshot()).toMatchObject({ canBack: true, backAppId: 'tasks' })
  })
})
