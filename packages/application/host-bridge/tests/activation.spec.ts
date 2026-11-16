import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

import { chmodSync } from 'node:fs'
import { host } from './harness.ts'
import { waitFor } from './harness.ts'

describe('activation failures', () => {
  it('reports a corrupt table and leaves applications enabled', async () => {
    const dir = home()
    const path = join(dir, 'activation.json')
    writeFileSync(path, '{ not json')
    try {
      const mounted = await host([{ id: 'demo', name: 'Demo', description: 'demo', version: '1.0.0', ops: { echo: { description: 'echo', params: {}, result: { type: 'json' }, execute: () => ({}) } } }], {}, { activationPath: path })
      await waitFor(() => mounted.bridge.list().length === 1)
      expect(mounted.bridge.list()[0]).toMatchObject({ activation: 'enabled' })
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
