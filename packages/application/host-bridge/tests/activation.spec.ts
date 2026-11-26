import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActivationFileStore } from '../src/activation.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'application-harness-activation-file-'))
}

describe('the durable activation table', () => {
  it('treats a missing file as enabled and round-trips disabled ids', async () => {
    const dir = home()
    try {
      const store = new ActivationFileStore(join(dir, 'activation.json'))
      expect(await store.list()).toEqual([])
      await store.save(['notes', 'tasks'])
      expect(await store.list()).toEqual(['notes', 'tasks'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a corrupt or malformed table instead of treating it as enabled', async () => {
    const dir = home()
    try {
      const path = join(dir, 'activation.json')
      const store = new ActivationFileStore(path)
      writeFileSync(path, '{ not json')
      await expect(store.list()).rejects.toThrow(/not valid JSON/u)
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, disabled: {} }))
      await expect(store.list()).rejects.toThrow(/carries no disabled array/u)
      for (const value of [null, '', 1]) {
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, disabled: [value] }))
        await expect(store.list()).rejects.toThrow(/malformed application id/u)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

import { host, waitFor } from './harness.ts'

describe('activation failures', () => {
  it('fails closed on a corrupt table and starts nothing until it is repaired', async () => {
    const dir = home()
    const path = join(dir, 'activation.json')
    writeFileSync(path, '{ not json')
    let starts = 0
    try {
      const mounted = await host([{
        id: 'demo',
        name: 'Demo',
        description: 'demo',
        version: '1.0.0',
        start: () => { starts += 1 },
        ops: { echo: { description: 'echo', params: {}, result: { type: 'json' }, execute: () => ({}) } },
      }], {}, { activationPath: path, preActivation: true })
      await waitFor(() => mounted.bridge.list().length === 1)
      expect(mounted.bridge.list()[0]).toMatchObject({ activation: 'disabled', runtime: 'stopped', activationUnavailable: true })
      expect(starts).toBe(0)
      expect(readFileSync(path, 'utf8')).toBe('{ not json')
      // A late registration also resolves disabled; it never runs its start hook.
      let lateStarts = 0
      mounted.runtime.mount({
        id: 'late', name: 'Late', description: 'late', version: '1.0.0',
        start: () => { lateStarts += 1 },
        ops: { echo: { description: 'echo', params: {}, result: { type: 'json' }, execute: () => ({}) } },
      })
      expect(mounted.runtime.list().find(entry => entry.declaration.id === 'late')?.activation()).toBe('disabled')
      expect(lateStarts).toBe(0)

      // A successful explicit write repairs the table and allows the app to run.
      await mounted.bridge.setActivation('demo', 'enabled')
      await waitFor(() => mounted.bridge.list()[0]?.runtime === 'ready')
      expect(mounted.bridge.list()[0]).toMatchObject({ activation: 'enabled' })
      expect(mounted.bridge.list()[0]?.activationUnavailable).toBeUndefined()
      expect(starts).toBe(1)
      await mounted.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not claim success when the activation table cannot be saved', async () => {
    const dir = home()
    const path = join(dir, 'activation.json')
    try {
      const mounted = await host([{ id: 'demo', name: 'Demo', description: 'demo', version: '1.0.0', ops: { echo: { description: 'echo', params: {}, result: { type: 'json' }, execute: () => ({}) } } }], {}, { activationPath: path })
      chmodSync(dir, 0o500)
      await expect(mounted.bridge.setActivation('demo', 'disabled')).rejects.toThrow()
      chmodSync(dir, 0o700)
      expect(mounted.bridge.list()[0]).toMatchObject({ activation: 'enabled' })

      // Now the table has a disabled id; a failed re-enable must restore it.
      await mounted.bridge.setActivation('demo', 'disabled')
      chmodSync(dir, 0o500)
      await expect(mounted.bridge.setActivation('demo', 'enabled')).rejects.toThrow()
      chmodSync(dir, 0o700)
      expect(mounted.bridge.list()[0]).toMatchObject({ activation: 'disabled' })
      await mounted.dispose()
    } finally {
      try { chmodSync(dir, 0o700) } catch { /* already restored */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
