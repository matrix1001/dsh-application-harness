import { describe, expect, it } from 'vitest'
import {
  attributeSessions, isWithin, matchWorkspace, normalizePrefix, resolveParents, unmatchedCount,
} from '../src/attribution.ts'
import { session, workspace } from './helpers.ts'

describe('workspace attribution', () => {
  it('normalizes prefixes and tests containment at path boundaries', () => {
    expect(normalizePrefix('/work/alpha/')).toBe('/work/alpha')
    expect(normalizePrefix('/')).toBe('/')
    expect(isWithin('/work/alpha', '/work/alpha')).toBe(true)
    expect(isWithin('/work/alpha/', '/work/alpha/src')).toBe(true)
    expect(isWithin('/work/alpha', '/work/alphabet')).toBe(false)
    expect(isWithin('/', '/anything')).toBe(true)
  })

  it('picks the longest matching root or alias, never a sibling prefix', () => {
    const alpha = workspace({ id: 'w_alpha', root: '/work/alpha' })
    const nested = workspace({ id: 'w_nested', root: '/work/alpha/packages/app' })
    const alias = workspace({ id: 'w_alias', root: '/work/other', aliases: ['/work/alpha/shared'] })
    expect(matchWorkspace('', [alpha])).toBeUndefined()
    expect(matchWorkspace('/work/alpha/src', [alpha, nested])?.id).toBe('w_alpha')
    expect(matchWorkspace('/work/alpha/packages/app/src', [alpha, nested])?.id).toBe('w_nested')
    expect(matchWorkspace('/work/alpha/shared/file', [alpha, alias])?.id).toBe('w_alias')
    expect(matchWorkspace('/work/alphabet', [alpha])).toBeUndefined()
  })

  it('resolves parents by agent-native id, skipping self and missing parents', () => {
    const parent = session({ id: 's_parent', nativeId: 'root', cwd: '/work/alpha' })
    const child = session({ id: 's_child', nativeId: 'child', parentNativeId: 'root', cwd: '' })
    const otherAgent = session({ id: 's_other', agent: 'codex', nativeId: 'child', parentNativeId: 'root' })
    const self = session({ id: 's_self', nativeId: 'self', parentNativeId: 'self' })
    const missing = session({ id: 's_missing', nativeId: 'orphan', parentNativeId: 'gone' })
    const parents = resolveParents([parent, child, otherAgent, self, missing])
    expect(parents.get('s_child')).toBe('s_parent')
    expect(parents.get('s_other')).toBeUndefined()
    expect(parents.get('s_self')).toBeUndefined()
    expect(parents.get('s_missing')).toBeUndefined()
  })

  it('attributes cwd matches, parent inheritance, manual assignments and unmatched sessions', () => {
    const alpha = workspace({ id: 'w_alpha', root: '/work/alpha' })
    const beta = workspace({ id: 'w_beta', root: '/work/beta' })
    const parent = session({ id: 's_parent', nativeId: 'root', cwd: '/work/alpha/src' })
    const child = session({ id: 's_child', nativeId: 'child', cwd: '', parentNativeId: 'root' })
    const grandchild = session({ id: 's_grand', nativeId: 'grand', cwd: '', parentNativeId: 'child' })
    const manual = session({ id: 's_manual', cwd: '', workspaceId: 'w_beta', assignedBy: 'manual' })
    const manualGone = session({ id: 's_manual_gone', cwd: '/work/alpha/x', workspaceId: 'w_missing', assignedBy: 'manual' })
    const outsider = session({ id: 's_out', cwd: '/elsewhere' })
    const cycleA = session({ id: 's_cycle_a', nativeId: 'a', cwd: '', parentNativeId: 'b' })
    const cycleB = session({ id: 's_cycle_b', nativeId: 'b', cwd: '', parentNativeId: 'a' })
    const assignments = attributeSessions(
      [grandchild, child, parent, manual, manualGone, outsider, cycleA, cycleB],
      [alpha, beta],
    )
    expect(assignments.get('s_parent')).toBe('w_alpha')
    expect(assignments.get('s_child')).toBe('w_alpha')
    expect(assignments.get('s_grand')).toBe('w_alpha')
    expect(assignments.get('s_manual')).toBe('w_beta')
    expect(assignments.get('s_manual_gone')).toBe('w_alpha')
    expect(assignments.get('s_out')).toBeUndefined()
    expect(assignments.get('s_cycle_a')).toBeUndefined()
    expect(unmatchedCount(assignments)).toBe(3)
  })
})

describe('attribution edge cases', () => {
  it('leaves a manual assignment with a vanished workspace to the cwd rule', () => {
    const alpha = workspace({ id: 'w_alpha', root: '/work/alpha' })
    const orphan = session({ id: 's_orphan', cwd: '', workspaceId: 'w_gone', assignedBy: 'manual' })
    const assignments = attributeSessions([orphan], [alpha])
    expect(assignments.get('s_orphan')).toBeUndefined()
    expect(normalizePrefix('/work/alpha///')).toBe('/work/alpha')
  })
})
