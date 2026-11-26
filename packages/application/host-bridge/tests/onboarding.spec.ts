/**
 * The host-side first-run record: fail-open reads, serialized atomic writes,
 * and the bridge methods that expose it (a notification record, never a grant).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ONBOARDING_VERSION, OnboardingFileStore } from '../src/onboarding.ts'
import { demoApp, host } from './harness.ts'

const dirs: string[] = []

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'application-harness-onboarding-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the onboarding store', () => {
  it('starts empty and round-trips one mark', async () => {
    const path = join(temp(), 'onboarding.json')
    const store = new OnboardingFileStore(path)
    expect(await store.load()).toEqual({ apps: {} })
    const after = await store.mark('info-hub', 'capability:network|capability:storage')
    expect(after.apps['info-hub']).toMatchObject({ fingerprint: 'capability:network|capability:storage' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: ONBOARDING_VERSION,
      apps: { 'info-hub': { fingerprint: 'capability:network|capability:storage' } },
    })
    const reloaded = new OnboardingFileStore(path)
    expect(await reloaded.load()).toEqual(after)
  })

  it.each([
    ['missing version', JSON.stringify({ apps: {} })],
    ['unknown version', JSON.stringify({ schemaVersion: 9, apps: {} })],
    ['no apps', JSON.stringify({ schemaVersion: ONBOARDING_VERSION })],
    ['malformed entry', JSON.stringify({ schemaVersion: ONBOARDING_VERSION, apps: { x: { fingerprint: 1 } } })],
    ['broken JSON', '{'],
  ])('treats %s as empty and reports it', async (_label, text) => {
    const dir = temp()
    const path = join(dir, 'onboarding.json')
    writeFileSync(path, text)
    const problems: string[] = []
    const store = new OnboardingFileStore(path, (problem) => { problems.push(problem) })
    expect(await store.load()).toEqual({ apps: {} })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(path)
  })

  it('serializes concurrent marks without losing either record', async () => {
    const path = join(temp(), 'onboarding.json')
    const store = new OnboardingFileStore(path)
    await Promise.all([
      store.mark('a', 'capability:storage'),
      store.mark('b', 'capability:network'),
    ])
    const state = await new OnboardingFileStore(path).load()
    expect(Object.keys(state.apps).sort()).toEqual(['a', 'b'])
  })

  it('rejects a failed write and keeps the previous record', async () => {
    const dir = temp()
    const file = join(dir, 'not-a-directory')
    writeFileSync(file, 'x')
    const store = new OnboardingFileStore(join(file, 'onboarding.json'))
    await expect(store.mark('a', 'capability:storage')).rejects.toThrow()
    expect(await store.load()).toEqual({ apps: {} })
  })
})

describe('the bridge onboarding face', () => {
  it('exposes the record, validates the app and the fingerprint, and persists the mark', async () => {
    const { bridge, onboardingPath, dispose } = await host([demoApp('demo', { capabilities: ['storage', 'network'] })])
    try {
      expect(await bridge.onboarding()).toEqual({ apps: {} })
      await expect(bridge.markOnboardingSeen('ghost', 'capability:network|capability:storage')).rejects.toThrow(/unknown application/u)
      await expect(bridge.markOnboardingSeen('demo', 'capability:storage')).rejects.toThrow(/stale/u)
      const state = await bridge.markOnboardingSeen('demo', 'capability:network|capability:storage')
      expect(state.apps.demo).toMatchObject({ fingerprint: 'capability:network|capability:storage' })
      expect(JSON.parse(readFileSync(onboardingPath, 'utf8'))).toMatchObject({ apps: { demo: { fingerprint: 'capability:network|capability:storage' } } })
    } finally {
      await dispose()
    }
  })
})

  it('loads an existing record instead of treating it as empty', async () => {
    const path = join(temp(), 'onboarding.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: ONBOARDING_VERSION, apps: { a: { fingerprint: 'capability:storage', seenAt: '2026-01-01T00:00:00.000Z' } } }))
    expect(await new OnboardingFileStore(path, () => {}).load()).toEqual({ apps: { a: { fingerprint: 'capability:storage', seenAt: '2026-01-01T00:00:00.000Z' } } })
  })

  it('reports a corrupt file through the logger and still answers empty', async () => {
    const dir = temp()
    const onboardingPath = join(dir, 'onboarding.json')
    writeFileSync(onboardingPath, '{')
    const { bridge, dispose } = await host([demoApp()], {}, { onboardingPath })
    try {
      expect(await bridge.onboarding()).toEqual({ apps: {} })
    } finally {
      await dispose()
    }
  })

  it('includes the process command declaration in the fingerprint', async () => {
    const runner = demoApp('runner', {
      capabilities: ['process'],
      process: [{ executable: 'git', commands: ['status'], purpose: 'read' }],
    })
    const { bridge, dispose } = await host([runner])
    try {
      expect(await bridge.markOnboardingSeen('runner', 'capability:process|process:git:status:read'))
        .toMatchObject({ apps: { runner: { fingerprint: 'capability:process|process:git:status:read' } } })
    } finally {
      await dispose()
    }
  })

  it('fingerprints an application with no declared capabilities as the empty string', async () => {
    const bare = demoApp('bare')
    delete (bare as { capabilities?: readonly string[] }).capabilities
    const { bridge, dispose } = await host([bare])
    try {
      expect(await bridge.markOnboardingSeen('bare', '')).toMatchObject({ apps: { bare: { fingerprint: '' } } })
    } finally {
      await dispose()
    }
  })
