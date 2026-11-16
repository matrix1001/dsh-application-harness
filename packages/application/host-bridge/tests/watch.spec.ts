/**
 * The watch stream: one ready snapshot at open, then the runtime's live
 * notices — data changes, progress, and the confirmation questions the bridge
 * parks for a human — until the caller cancels or the row unloads.
 */

import { describe, expect, it } from 'vitest'
import { WATCH_QUEUE_CAPACITY } from '../src/index.ts'
import { demoApp, host, secretApp, waitFor } from './harness.ts'
import type { WatchEvent } from '../src/types.ts'

/** Read the next frame, failing loud when the stream ended instead. */
async function nextFrame(stream: AsyncIterator<WatchEvent>): Promise<WatchEvent> {
  const result = await stream.next()
  if (result.done === true) throw new Error('the watch stream ended before the expected frame')
  return result.value
}

describe('the watch stream', () => {
  it('carries startup, availability, stop and removal without a business change', async () => {
    const { runtime, bridge, dispose } = await host()
    const start = Promise.withResolvers<void>()
    const stream = bridge.watch()[Symbol.asyncIterator]()
    try {
      expect(await nextFrame(stream)).toMatchObject({ kind: 'ready', apps: [] })
      runtime.mount({ ...demoApp(), start: () => start.promise })
      expect(await nextFrame(stream)).toMatchObject({ kind: 'lifecycle', appId: 'demo', apps: [{ status: 'starting' }] })
      start.resolve()
      expect(await nextFrame(stream)).toMatchObject({ kind: 'lifecycle', apps: [{ status: 'available' }] })
      await runtime.stop('demo')
      expect(await nextFrame(stream)).toMatchObject({ kind: 'lifecycle', apps: [{ status: 'stopping' }] })
      expect(await nextFrame(stream)).toMatchObject({ kind: 'lifecycle', apps: [{ status: 'stopped' }] })
      runtime.unregister('demo')
      expect(await nextFrame(stream)).toMatchObject({ kind: 'lifecycle', apps: [] })
    } finally {
      start.resolve()
      await dispose()
    }
  })

  it('opens with a ready snapshot, then carries changes, progress and confirmations', async () => {
    const { runtime, bridge } = await host([demoApp(), secretApp()])
    const controller = new AbortController()
    const stream = bridge.watch(controller.signal)[Symbol.asyncIterator]()

    // The first frame is the whole application list, right at open.
    const ready = await nextFrame(stream)
    expect(ready).toMatchObject({ kind: 'ready' })
    if (ready.kind !== 'ready') throw new Error('expected the ready frame')
    expect(ready.apps.map((app) => [app.id, app.status])).toEqual([['demo', 'available'], ['secret-app', 'available']])
    expect(ready.apps[0]?.ops[0]).toMatchObject({ name: 'echo', exposure: {} })

    await bridge.call('demo', 'touch', {})
    expect(await nextFrame(stream)).toEqual({ kind: 'changed', appId: 'demo' })

    const tick = await bridge.call('demo', 'tick', {})
    expect(await nextFrame(stream)).toEqual({
      kind: 'progress',
      notice: { appId: 'demo', op: 'tick', callId: tick.callId, message: 'halfway', data: { done: 1 } },
    })

    // A confirmation asked outside any session rides the same stream, and the
    // answer that ends it does too.
    const call = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const asked = await nextFrame(stream)
    expect(asked).toMatchObject({
      kind: 'confirmation',
      action: 'asked',
      request: { caller: { kind: 'ai' }, capability: 'secret-app#secret' },
    })
    if (asked.kind !== 'confirmation' || asked.action !== 'asked') throw new Error('expected an asked frame')
    expect(bridge.answerConfirmation(asked.request.id, 'allowed-once')).toBe(true)
    expect(await nextFrame(stream)).toEqual({
      kind: 'confirmation',
      action: 'settled',
      id: asked.request.id,
      outcome: 'allowed-once',
    })
    await expect(call).resolves.toMatchObject({ status: 'success' })

    // The caller's cancellation ends the stream: it is the carrier's own signal.
    controller.abort()
    await expect(stream.next()).resolves.toMatchObject({ done: true })
  })

  it('fans one event out to every open stream', async () => {
    const { bridge } = await host([demoApp()])
    const first = bridge.watch(undefined)[Symbol.asyncIterator]()
    const second = bridge.watch(undefined)[Symbol.asyncIterator]()
    expect(await nextFrame(first)).toMatchObject({ kind: 'ready' })
    expect(await nextFrame(second)).toMatchObject({ kind: 'ready' })
    await bridge.call('demo', 'touch', {})
    expect(await nextFrame(first)).toEqual({ kind: 'changed', appId: 'demo' })
    expect(await nextFrame(second)).toEqual({ kind: 'changed', appId: 'demo' })
  })

  it('replaces a slow consumer backlog with one reset frame instead of growing', async () => {
    const { bridge, dispose } = await host([demoApp()])
    const stream = bridge.watch(undefined)[Symbol.asyncIterator]()
    try {
      // Do not consume the ready frame: the backlog crosses the bound.
      for (let index = 0; index <= WATCH_QUEUE_CAPACITY; index += 1) await bridge.call('demo', 'touch', {})
      expect(await nextFrame(stream)).toEqual({ kind: 'reset', reason: 'slow-consumer' })
      // The stream is still live after the reset.
      await bridge.call('demo', 'touch', {})
      expect(await nextFrame(stream)).toEqual({ kind: 'changed', appId: 'demo' })
    } finally {
      await dispose()
    }
  })

  it('delivers what is already queued before an ended stream closes', async () => {
    const { bridge, dispose } = await host([demoApp()])
    const stream = bridge.watch(undefined)[Symbol.asyncIterator]()
    expect(await nextFrame(stream)).toMatchObject({ kind: 'ready' })
    await bridge.call('demo', 'touch', {})
    await dispose()
    expect(await nextFrame(stream)).toEqual({ kind: 'changed', appId: 'demo' })
    await expect(stream.next()).resolves.toMatchObject({ done: true })
  })
})
