/**
 * The health-check face of the host bridge: the public rows carry the mapped
 * runtime/health/reason/detail, the explicit check command runs the declared
 * hook and answers the refreshed rows, an unhealthy report stops the instance
 * without touching the user's activation, and nothing restarts it on its own.
 */
import { describe, expect, it } from 'vitest'
import { demoApp, host } from './harness.ts'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime/types'

/** One scripted health result and the lifecycle counts the case observes. */
interface HealthState {
  readonly results: Array<{ status: 'ok' | 'degraded' | 'unhealthy'; reason?: string }>
  starts: number
  stops: number
}

/** One declaration with a mutable health hook and observable lifecycle counts. */
function healthApp(state: HealthState): AppDeclaration {
  return demoApp('demo', {
    start: () => { state.starts += 1 },
    stop: () => { state.stops += 1 },
    health: () => {
      const next = state.results.shift()
      return next ?? { status: 'ok' }
    },
  })
}

describe('application health', () => {
  it('maps a degraded report onto ready + health degraded + detail, and answers the rows', async () => {
    const state: HealthState = { results: [{ status: 'ok' }], starts: 0, stops: 0 }
    const mounted = await host([healthApp(state)])
    try {
      expect(mounted.bridge.list()[0]).toMatchObject({ runtime: 'ready', activation: 'enabled', health: 'ok' })
      state.results.push({ status: 'degraded', reason: 'the model is not configured' })
      const rows = await mounted.bridge.checkHealth('demo')
      expect(rows[0]).toMatchObject({
        runtime: 'ready',
        activation: 'enabled',
        health: 'degraded',
        detail: 'the model is not configured',
      })
      expect(rows[0]?.reason).toBeUndefined()
      // A later healthy result clears the diagnostic.
      state.results.push({ status: 'ok' })
      const cleared = await mounted.bridge.checkHealth('demo')
      expect(cleared[0]).toMatchObject({ runtime: 'ready', health: 'ok' })
      expect(cleared[0]?.detail).toBeUndefined()
      expect(cleared[0]?.reason).toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it('stops an unhealthy application, keeps activation enabled, and never restarts it on its own', async () => {
    const state: HealthState = {
      results: [{ status: 'unhealthy', reason: 'git is missing' }],
      starts: 0,
      stops: 0,
    }
    const mounted = await host([healthApp(state)])
    try {
      const row = mounted.bridge.list()[0]!
      expect(row).toMatchObject({
        runtime: 'stopped',
        activation: 'enabled',
        reason: 'platform.health-failed',
        detail: 'git is missing',
      })
      expect(row.health).toBeUndefined()
      expect(state.stops).toBe(1)
      // A call is refused while the instance is down.
      const refused = await mounted.bridge.call('demo', 'echo', { text: 'x' })
      expect(refused).toMatchObject({ status: 'rejected', error: { code: 'platform.stopping' } })
      // No timer or retry brings it back: the platform only stops.
      await new Promise((resolve) => { setTimeout(resolve, 10) })
      expect(state.starts).toBe(1)
      expect(mounted.bridge.list()[0]).toMatchObject({ runtime: 'stopped', reason: 'platform.health-failed' })
      // A stopped instance cannot be checked; the user must enable it again.
      await expect(mounted.bridge.checkHealth('demo')).rejects.toThrow(/enable it/u)
    } finally { await mounted.dispose() }
  })

  it('restarts a health-failed application only on an explicit enable', async () => {
    const state: HealthState = {
      results: [{ status: 'unhealthy', reason: 'git is missing' }, { status: 'ok' }],
      starts: 0,
      stops: 0,
    }
    const mounted = await host([healthApp(state)])
    try {
      expect(mounted.bridge.list()[0]).toMatchObject({ runtime: 'stopped', reason: 'platform.health-failed' })
      // The user's explicit enable is the recovery: it starts the instance and
      // waits for the fresh health result.
      const rows = await mounted.bridge.setActivation('demo', 'enabled')
      expect(state.starts).toBe(2)
      expect(rows[0]).toMatchObject({ runtime: 'ready', activation: 'enabled', health: 'ok' })
      expect(rows[0]?.reason).toBeUndefined()
      expect(rows[0]?.detail).toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it('reports a failing hook as degraded diagnostics instead of stopping the application', async () => {
    const declaration = demoApp('demo', {
      health: () => { throw new Error('the source probe failed') },
    })
    const mounted = await host([declaration])
    try {
      const row = mounted.bridge.list()[0]!
      expect(row).toMatchObject({ runtime: 'ready', activation: 'enabled', health: 'degraded' })
      expect(row.detail).toMatch(/health check failed: the source probe failed/u)
      expect(row.reason).toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it('checks an application that declares no hook as a no-op, and refuses an unknown id', async () => {
    const mounted = await host([demoApp('plain')])
    try {
      const rows = await mounted.bridge.checkHealth('plain')
      expect(rows[0]).toMatchObject({ runtime: 'ready', health: 'ok' })
      await expect(mounted.bridge.checkHealth('missing')).rejects.toThrow(/not registered/u)
    } finally { await mounted.dispose() }
  })
})
