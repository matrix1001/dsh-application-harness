import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_RETENTION, MAX_REVIEW_RETENTION, defaultReviewSettings, defaultSourceRoots, mergeSettings, normalizeSettings,
} from '../src/settings.ts'

describe('settings', () => {
  it('builds defaults from one home without touching the module-level environment', () => {
    expect(defaultSourceRoots('/home/ada', '/home/ada/.dsh')).toEqual({
      dsh: '/home/ada/.dsh/sessions',
      claudeCode: '/home/ada/.claude/projects',
      codex: '/home/ada/.codex/sessions',
    })
    expect(defaultReviewSettings('/home/ada')).toMatchObject({
      redactSecrets: true,
      reviewRetention: DEFAULT_REVIEW_RETENTION,
      aiEnabled: true,
    })
  })

  it('normalizes a missing/partial/corrupt settings document field by field', () => {
    const defaults = defaultReviewSettings('/home/ada')
    expect(normalizeSettings(undefined, defaults)).toEqual(defaults)
    expect(normalizeSettings({ sourceRoots: { dsh: '  /srv/dsh  ' }, redactSecrets: false, reviewRetention: 3, aiEnabled: false }, defaults)).toEqual({
      sourceRoots: { dsh: '/srv/dsh', claudeCode: defaults.sourceRoots.claudeCode, codex: defaults.sourceRoots.codex },
      redactSecrets: false,
      reviewRetention: 3,
      aiEnabled: false,
    })
    expect(normalizeSettings({ sourceRoots: { dsh: '', claudeCode: 3, codex: ' /srv/codex ' }, redactSecrets: 'yes', reviewRetention: 99, aiEnabled: 1 }, defaults)).toEqual({
      sourceRoots: { dsh: defaults.sourceRoots.dsh, claudeCode: defaults.sourceRoots.claudeCode, codex: '/srv/codex' },
      redactSecrets: true,
      reviewRetention: 20,
      aiEnabled: true,
    })
    expect(normalizeSettings({ sourceRoots: 'nope' }, defaults)).toEqual(defaults)
  })

  it('refuses malformed patches instead of silently repairing them', () => {
    const current = defaultReviewSettings('/home/ada')
    expect(() => mergeSettings(current, null)).toThrow(/settings must be an object/)
    expect(() => mergeSettings(current, { sourceRoots: 'nope' })).toThrow(/sourceRoots must be an object/)
    expect(() => mergeSettings(current, { sourceRoots: { dsh: '' } })).toThrow(/sourceRoots\.dsh/)
    expect(() => mergeSettings(current, { sourceRoots: { claudeCode: 3 } })).toThrow(/sourceRoots\.claudeCode/)
    expect(() => mergeSettings(current, { sourceRoots: { codex: '' } })).toThrow(/sourceRoots\.codex/)
    expect(() => mergeSettings(current, { redactSecrets: 'yes' })).toThrow(/redactSecrets/)
    expect(() => mergeSettings(current, { reviewRetention: 0 })).toThrow(/reviewRetention/)
    expect(() => mergeSettings(current, { reviewRetention: MAX_REVIEW_RETENTION + 1 })).toThrow(/reviewRetention/)
    expect(() => mergeSettings(current, { reviewRetention: 1.5 })).toThrow(/reviewRetention/)
    expect(() => mergeSettings(current, { aiEnabled: 'yes' })).toThrow(/aiEnabled/)
  })

  it('merges each supported field', () => {
    const current = defaultReviewSettings('/home/ada')
    expect(mergeSettings(current, {
      sourceRoots: { dsh: '/srv/dsh', claudeCode: '/srv/claude', codex: '/srv/codex' },
      redactSecrets: false,
      reviewRetention: 1,
      aiEnabled: false,
    })).toEqual({
      sourceRoots: { dsh: '/srv/dsh', claudeCode: '/srv/claude', codex: '/srv/codex' },
      redactSecrets: false,
      reviewRetention: 1,
      aiEnabled: false,
    })
    expect(mergeSettings(current, {})).toEqual(current)
  })
})

describe('settings source root environment', () => {
  it('uses DSH_HOME for the DSH root when the environment provides one', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/srv/dsh'
    try {
      expect(defaultSourceRoots('/home/ada').dsh).toBe('/srv/dsh/sessions')
      expect(defaultReviewSettings('/home/ada').sourceRoots.dsh).toBe('/srv/dsh/sessions')
      process.env.DSH_HOME = ''
      expect(defaultSourceRoots('/home/ada').dsh).toBe('/home/ada/.dsh/sessions')
      delete process.env.DSH_HOME
      expect(defaultSourceRoots('/home/ada').dsh).toBe('/home/ada/.dsh/sessions')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
